//! Procedencia y autorización por cuenta de las notas locales (AUD-001).
//!
//! El directorio local `~/Documents/lyra/` es único y compartido entre todas las
//! cuentas de Google Drive. Este módulo mantiene un libro de procedencia
//! (`.lyra_provenance.json`) que registra a qué cuenta pertenece cada nota y si
//! esa cuenta está autorizada a subirla.
//!
//! Reglas fundamentales:
//! - Ninguna nota local se sube a una cuenta sin una autorización verificable.
//! - Iniciar sesión o cambiar de cuenta NO autoriza notas existentes.
//! - La autorización se concede por nota, no por carpeta ni por sesión futura.
//! - Ante estado desconocido o corrupto se falla cerrado (no se sube nada).
//! - Nada de lo que ocurra aquí borra, oculta ni mueve notas locales.

use md5::Md5;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::types::SyncManifest;

pub const PROVENANCE_FILE_NAME: &str = ".lyra_provenance.json";
pub const PROVENANCE_VERSION: u32 = 1;


/// Estado de vinculación de una nota con una cuenta concreta.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountLinkState {
    /// La cuenta puede subir esta nota.
    Authorized,
    /// La nota existe localmente pero la cuenta no está autorizada a subirla.
    Pending,
}

/// Cómo llegó la nota al directorio local compartido.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteOrigin {
    Unknown,
    Downloaded,
    CreatedLocally,
    LegacyManifest,
}

/// Evidencia con la que se concedió una autorización.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorizationSource {
    None,
    AutomaticDownload,
    AutomaticLocalCreation,
    LegacyEvidence,
    ExplicitConsent,
}

/// Vinculación verificable entre una nota y una cuenta de Google Drive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountBinding {
    pub account_key: String,
    pub state: AccountLinkState,
    pub origin: NoteOrigin,
    pub source: AuthorizationSource,
    #[serde(default)]
    pub authorized_at: Option<i64>,
    #[serde(default)]
    pub drive_id: Option<String>,
    #[serde(default)]
    pub md5: Option<String>,
}

/// Identidad persistente de una nota local.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRecord {
    pub note_id: String,
    pub name: String,
    #[serde(default)]
    pub first_seen_mtime: i64,
    #[serde(default)]
    pub last_seen_mtime: i64,
    #[serde(default)]
    pub last_size: u64,
    #[serde(default)]
    pub last_md5: String,
    #[serde(default)]
    pub last_seen_at: i64,
    #[serde(default)]
    pub retired: bool,
    #[serde(default)]
    pub missing_since: Option<i64>,
    #[serde(default)]
    pub bindings: BTreeMap<String, AccountBinding>,
    /// Digest of the exact app-created welcome content while this identity is internal.
    #[serde(default)]
    pub internal_welcome_sha256: Option<String>,
}

impl NoteRecord {
    fn new(note_id: String, name: String, mtime: i64, size: u64, md5: &str, now: i64) -> Self {
        Self {
            note_id,
            name,
            first_seen_mtime: mtime,
            last_seen_mtime: mtime,
            last_size: size,
            last_md5: md5.to_string(),
            last_seen_at: now,
            retired: false,
            missing_since: None,
            bindings: BTreeMap::new(),
            internal_welcome_sha256: None,
        }
    }
}

/// Sesión de una cuenta. El snapshot de nombres se toma al iniciar sesión para
/// distinguir notas preexistentes de notas creadas durante la sesión activa.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountSession {
    pub account_key: String,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub snapshot_names: BTreeSet<String>,
}

/// Identidad mínima de una nota pendiente de autorización.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingNote {
    pub note_id: String,
    pub name: String,
    pub mtime: i64,
    pub size: u64,
}

/// Solicitud de consentimiento concreta y verificable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAuthorization {
    pub account_key: String,
    #[serde(default)]
    pub account_email: Option<String>,
    pub request_id: String,
    pub notes: Vec<PendingNote>,
    pub created_at: i64,
}

/// Libro de procedencia persistente.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvenanceLedger {
    pub version: u32,
    #[serde(default)]
    pub notes: BTreeMap<String, NoteRecord>,
    #[serde(default)]
    pub by_name: BTreeMap<String, String>,
    #[serde(default)]
    pub sessions: BTreeMap<String, AccountSession>,
    #[serde(default)]
    pub pending: BTreeMap<String, PendingAuthorization>,
    /// Firmas de solicitudes rechazadas explícitamente por el usuario.
    /// Si el conjunto de notas no cambia, no se vuelve a preguntar.
    #[serde(default)]
    pub declined: BTreeMap<String, String>,
    /// Per-account note identities explicitly left local by the user.
    #[serde(default)]
    pub declined_note_ids: BTreeMap<String, BTreeSet<String>>,
}

impl Default for ProvenanceLedger {
    fn default() -> Self {
        Self {
            version: PROVENANCE_VERSION,
            notes: BTreeMap::new(),
            by_name: BTreeMap::new(),
            sessions: BTreeMap::new(),
            pending: BTreeMap::new(),
            declined: BTreeMap::new(),
            declined_note_ids: BTreeMap::new(),
        }
    }
}

/// Vista enviada al frontend (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuthorizationView {
    pub account_key: String,
    pub account_email: Option<String>,
    pub request_id: String,
    pub note_count: usize,
    pub notes: Vec<PendingNoteView>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingNoteView {
    pub note_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteStatusView {
    pub note_id: String,
    pub name: String,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteManagementView {
    pub account_key: String,
    pub account_email: Option<String>,
    pub notes: Vec<LocalNoteStatusView>,
    pub request: Option<PendingAuthorizationView>,
}

impl PendingAuthorization {
    pub fn to_view(&self) -> PendingAuthorizationView {
        PendingAuthorizationView {
            account_key: self.account_key.clone(),
            account_email: self.account_email.clone(),
            request_id: self.request_id.clone(),
            note_count: self.notes.len(),
            notes: self.notes.iter().map(|n| PendingNoteView { note_id: n.note_id.clone(), name: n.name.clone() }).collect(),
            created_at: self.created_at,
        }
    }
}

// ---------------------------------------------------------------------------
// Persistencia atómica con respaldo .bak
// ---------------------------------------------------------------------------

pub fn get_ledger_path(lyra_dir: &Path) -> PathBuf {
    lyra_dir.join(PROVENANCE_FILE_NAME)
}

fn parse_ledger(content: &str) -> Result<ProvenanceLedger, String> {
    let ledger: ProvenanceLedger = serde_json::from_str(content)
        .map_err(|e| format!("libro de procedencia inválido: {e}"))?;
    if ledger.version != PROVENANCE_VERSION {
        return Err(format!(
            "versión de libro de procedencia no soportada: {} (esperada {})",
            ledger.version, PROVENANCE_VERSION
        ));
    }
    Ok(ledger)
}

/// Carga el libro de procedencia.
///
/// - Archivo ausente => `Ok(None)` (instalación nueva).
/// - Archivo corrupto con `.bak` válido => recupera desde la copia.
/// - Archivo corrupto sin respaldo válido => `Err` (el llamador debe fallar cerrado).
pub fn load_ledger(path: &Path) -> Result<Option<ProvenanceLedger>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let main_result = fs::read_to_string(path)
        .map_err(|e| format!("no se pudo leer '{}': {e}", path.display()))
        .and_then(|content| parse_ledger(&content));

    match main_result {
        Ok(ledger) => Ok(Some(ledger)),
        Err(main_err) => {
            let bak_path = path.with_extension("json.bak");
            if bak_path.exists() {
                if let Ok(content) = fs::read_to_string(&bak_path) {
                    if let Ok(ledger) = parse_ledger(&content) {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[Provenance] Libro de procedencia recuperado desde '{}' ({main_err}).",
                            bak_path.display()
                        );
                        return Ok(Some(ledger));
                    }
                }
            }
            Err(format!(
                "El libro de procedencia de notas está dañado y no hay respaldo válido ({main_err}). \
                 Por seguridad no se subirá ninguna nota a Google Drive. \
                 Restaura '{}' desde una copia de seguridad o elimínalo para reiniciar el estado de autorizaciones.",
                path.display()
            ))
        }
    }
}

/// Guarda el libro de forma atómica, conservando la versión anterior en `.bak`.
pub fn save_ledger(path: &Path, ledger: &ProvenanceLedger) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let content = serde_json::to_string_pretty(ledger)
        .map_err(|e| format!("error serializando libro de procedencia: {e}"))?;

    let bak_path = path.with_extension("json.bak");
    if path.exists() {
        // Do not replace a valid backup with a corrupt primary recovered from
        // that backup during this load/save cycle.
        if fs::read_to_string(path).ok().is_some_and(|raw| parse_ledger(&raw).is_ok()) {
            let _ = fs::copy(path, &bak_path);
        }
    }

    let rand_num: u32 = rand::random();
    let tmp_path = path.with_file_name(format!(".lyra_provenance.tmp.{rand_num}"));

    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| format!("no se pudo crear temporal del libro de procedencia: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("no se pudo escribir temporal del libro de procedencia: {e}"))?;
        file.flush().map_err(|e| format!("cannot flush provenance ledger: {e}"))?;
        file.sync_all().map_err(|e| format!("cannot sync provenance ledger: {e}"))?;
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("no se pudo guardar el libro de procedencia: {e}"));
    }

    Ok(())
}

fn new_note_id() -> String {
    format!("note_{:032x}", rand::random::<u128>())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Nombres de notas válidas presentes en el directorio compartido.
pub fn snapshot_note_names(lyra_dir: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Ok(entries) = fs::read_dir(lyra_dir) else {
        return names;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if name.ends_with(".txt") || name.ends_with(".md") {
            names.insert(name.to_string());
        }
    }
    names
}

/// Firma determinista de una solicitud de consentimiento.
///
/// Incluye la cuenta, la época de la sesión y la identidad ordenada de cada nota.
/// Si cualquier nota cambia (nombre, mtime, tamaño) o desaparece, la firma deja
/// de coincidir y la aprobación se rechaza.
pub fn compute_request_id(account_key: &str, epoch: u64, notes: &[PendingNote]) -> String {
    let mut ordered: Vec<&PendingNote> = notes.iter().collect();
    ordered.sort_by(|a, b| a.note_id.cmp(&b.note_id).then(a.name.cmp(&b.name)));

    let mut input = format!("v1\n{account_key}\n{epoch}\n");
    for note in ordered {
        input.push_str(&format!(
            "{}|{}|{}|{}\n",
            note.note_id, note.name, note.mtime, note.size
        ));
    }

    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ---------------------------------------------------------------------------
// Operaciones de sesión y consentimiento (sin contexto de sincronización)
// ---------------------------------------------------------------------------

/// Inicia una sesión nueva para la cuenta tras completar el OAuth.
///
/// Cambiar de cuenta o volver a iniciar sesión NO autoriza ninguna nota: el
/// snapshot se toma sobre el estado actual del directorio compartido.
pub fn start_account_session(
    lyra_dir: &Path,
    account_key: &str,
    epoch: u64,
) -> Result<(), String> {
    let path = get_ledger_path(lyra_dir);
    let mut ledger = load_ledger(&path)?.unwrap_or_default();
    let snapshot = snapshot_note_names(lyra_dir);
    ledger.sessions.insert(
        account_key.to_string(),
        AccountSession {
            account_key: account_key.to_string(),
            started_at: now_ms(),
            ended_at: None,
            epoch,
            snapshot_names: snapshot,
        },
    );
    save_ledger(&path, &ledger)
}

/// Marca el fin de la sesión de una cuenta al cerrar sesión.
pub fn end_account_session(lyra_dir: &Path, account_key: &str) -> Result<(), String> {
    let path = get_ledger_path(lyra_dir);
    let Some(mut ledger) = load_ledger(&path)? else {
        return Ok(());
    };
    if let Some(session) = ledger.sessions.get_mut(account_key) {
        session.ended_at = Some(now_ms());
    }
    save_ledger(&path, &ledger)
}

/// Retira una nota del libro cuando se elimina localmente de forma intencional.
pub fn retire_note(lyra_dir: &Path, name: &str) -> Result<(), String> {
    let path = get_ledger_path(lyra_dir);
    let Some(mut ledger) = load_ledger(&path)? else {
        return Ok(());
    };
    let now = now_ms();
    if let Some(note_id) = ledger.by_name.remove(name) {
        if let Some(record) = ledger.notes.get_mut(&note_id) {
            record.retired = true;
            record.missing_since = Some(now);
        }
    }
    save_ledger(&path, &ledger)
}

/// Only the backend file operations call this after an exclusive create or an
/// atomic save. A scan never treats a newly appearing filename as creation.
pub fn record_local_write(
    lyra_dir: &Path,
    name: &str,
    account_key: Option<&str>,
    created: bool,
) -> Result<(), String> {
    let path = get_ledger_path(lyra_dir);
    let mut ledger = load_ledger(&path)?.unwrap_or_default();
    let file_path = lyra_dir.join(name);
    let bytes = fs::read(&file_path).map_err(|e| format!("cannot read created note: {e}"))?;
    let metadata = fs::metadata(&file_path).map_err(|e| format!("cannot stat created note: {e}"))?;
    let mtime = metadata.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64).unwrap_or(-1);
    let mut hasher = Md5::new();
    hasher.update(&bytes);
    let md5 = format!("{:x}", hasher.finalize());
    let now = now_ms();
    let existing = ledger.by_name.get(name).cloned();
    let note_id = if created {
        // O_EXCL at the call site proves this was a new file. Never inherit a
        // previous record even if the filename is reused.
        if let Some(old_id) = existing {
            if let Some(old) = ledger.notes.get_mut(&old_id) {
                old.retired = true;
                old.missing_since = Some(now);
            }
        }
        new_note_id()
    } else {
        existing.filter(|id| ledger.notes.get(id).map(|r| !r.retired).unwrap_or(false))
            .unwrap_or_else(new_note_id)
    };
    let record = ledger.notes.entry(note_id.clone()).or_insert_with(|| {
        NoteRecord::new(note_id.clone(), name.to_string(), mtime, metadata.len(), &md5, now)
    });
    record.name = name.to_string();
    record.last_seen_mtime = mtime;
    record.last_size = metadata.len();
    record.last_md5 = md5.clone();
    if let Some(original_digest) = &record.internal_welcome_sha256 {
        let current_digest = format!("{:x}", Sha256::digest(&bytes));
        if &current_digest != original_digest {
            record.internal_welcome_sha256 = None;
        }
    }
    record.last_seen_at = now;
    record.missing_since = None;
    if created {
        if let Some(key) = account_key {
            record.bindings.insert(key.to_string(), AccountBinding {
                account_key: key.to_string(), state: AccountLinkState::Authorized,
                origin: NoteOrigin::CreatedLocally,
                source: AuthorizationSource::AutomaticLocalCreation,
                authorized_at: Some(now), drive_id: None, md5: Some(md5),
            });
        }
    }
    ledger.by_name.insert(name.to_string(), note_id);
    save_ledger(&path, &ledger)
}

/// Called only after Rust exclusively created the canonical welcome file.
/// A failed ledger write leaves an ordinary local note, never an implicit upload grant.
pub fn mark_internal_welcome(lyra_dir: &Path, name: &str, content: &[u8]) -> Result<(), String> {
    let path = get_ledger_path(lyra_dir);
    let mut ledger = load_ledger(&path)?.ok_or("Missing note ledger")?;
    let note_id = ledger.by_name.get(name).ok_or("Missing welcome note identity")?.clone();
    let record = ledger.notes.get_mut(&note_id).ok_or("Missing welcome note record")?;
    if record.retired || !record.bindings.is_empty() || fs::read(lyra_dir.join(name)).map_err(|e| e.to_string())? != content {
        return Err("Welcome note changed before classification".into());
    }
    record.internal_welcome_sha256 = Some(format!("{:x}", Sha256::digest(content)));
    save_ledger(&path, &ledger)
}

pub fn is_verified_internal_welcome(lyra_dir: &Path, name: &str) -> Result<bool, String> {
    let Some(ledger) = load_ledger(&get_ledger_path(lyra_dir))? else { return Ok(false) };
    let Some(record) = ledger.by_name.get(name).and_then(|id| ledger.notes.get(id)) else { return Ok(false) };
    let Some(expected) = record.internal_welcome_sha256.as_ref() else { return Ok(false) };
    if record.retired { return Ok(false); }
    let file = lyra_dir.join(name);
    if !fs::symlink_metadata(&file).map_err(|e| e.to_string())?.file_type().is_file() { return Ok(false); }
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(&bytes)) == *expected)
}

/// Creates a note exclusively, then records its verified account. The file
/// remains local if ledger persistence fails; no cloud grant is fabricated.
pub fn create_local_note(
    lyra_dir: &Path, name: &str, content: &[u8], account_key: Option<&str>,
) -> Result<(), String> {
    let target = lyra_dir.join(name);
    match super::sync::write_file_atomic_exclusive(&target, content) {
        Ok(outcome) => {
            if outcome == super::sync::ExclusivePublishOutcome::PublishedUnsynced {
                #[cfg(debug_assertions)]
                eprintln!("[create_local_note] Note published without parent dir sync (durability degraded)");
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!("Cannot create note: {e}"));
        }
        Err(e) => {
            return Err(format!("Cannot create note: {e}"));
        }
    }
    if let Err(_e) = record_local_write(lyra_dir, name, account_key, true) {
        #[cfg(debug_assertions)]
        eprintln!("[create_local_note] Note is local only: {_e}");
    }
    Ok(())
}

/// Before a Lyra save, invalidate a record if the on-disk bytes were changed
/// outside Lyra since its last trusted observation.
pub fn invalidate_changed_note(lyra_dir: &Path, name: &str) -> Result<(), String> {
    let ledger_path = get_ledger_path(lyra_dir);
    let Some(mut ledger) = load_ledger(&ledger_path)? else { return Ok(()) };
    let Some(note_id) = ledger.by_name.get(name).cloned() else { return Ok(()) };
    let Some(record) = ledger.notes.get(&note_id) else { return Ok(()) };
    let unchanged = match fs::read(lyra_dir.join(name)) {
        Ok(bytes) => {
            let mut hasher = Md5::new();
            hasher.update(&bytes);
            record.last_md5 == format!("{:x}", hasher.finalize())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("cannot verify note before save: {e}")),
    };
    if unchanged { return Ok(()) }
    ledger.by_name.remove(name);
    if let Some(record) = ledger.notes.get_mut(&note_id) {
        record.retired = true;
        record.missing_since = Some(now_ms());
    }
    save_ledger(&ledger_path, &ledger)
}

pub fn authorized_deletion(
    lyra_dir: &Path, name: &str, account_key: &str, drive_id: &str,
) -> Result<Option<String>, String> {
    let Some(ledger) = load_ledger(&get_ledger_path(lyra_dir))? else { return Ok(None) };
    let Some(note_id) = ledger.by_name.get(name) else { return Ok(None) };
    let Some(record) = ledger.notes.get(note_id) else { return Ok(None) };
    if record.retired || record.bindings.get(account_key)
        .map(|b| b.state != AccountLinkState::Authorized ||
            b.drive_id.as_deref() != Some(drive_id))
        .unwrap_or(true) {
        return Ok(None);
    }
    let bytes = fs::read(lyra_dir.join(name)).map_err(|e| format!("cannot verify note before deletion: {e}"))?;
    let mut hasher = Md5::new();
    hasher.update(&bytes);
    if record.last_md5 != format!("{:x}", hasher.finalize()) {
        return Ok(None);
    }
    Ok(Some(note_id.clone()))
}

pub fn retired_deletion_matches(
    lyra_dir: &Path, note_id: &str, account_key: &str, drive_id: &str,
) -> bool {
    load_ledger(&get_ledger_path(lyra_dir)).ok().flatten()
        .and_then(|ledger| ledger.notes.get(note_id).cloned())
        .map(|record| record.retired && record.bindings.get(account_key)
            .map(|b| b.state == AccountLinkState::Authorized &&
                b.drive_id.as_deref() == Some(drive_id))
            .unwrap_or(false))
        .unwrap_or(false)
}

/// Conserva la identidad y autorizaciones de una nota al renombrarla.
///
/// Si un escaneo concurrente ya registró el nombre nuevo como una nota distinta,
/// se adopta esa identidad duplicada (mismo contenido y sin autorizaciones) en
/// lugar de perder las autorizaciones de la nota original.
pub fn rename_note(lyra_dir: &Path, old_name: &str, new_name: &str) -> Result<bool, String> {
    let path = get_ledger_path(lyra_dir);
    let Some(mut ledger) = load_ledger(&path)? else {
        return Ok(false);
    };
    let Some(note_id) = ledger.by_name.get(old_name).cloned() else {
        return Ok(false);
    };
    // An arbitrary IPC call cannot launder an unrelated file into this identity.
    let Some(original) = ledger.notes.get(&note_id) else { return Ok(false) };
    let bytes = fs::read(lyra_dir.join(new_name)).map_err(|e| format!("cannot verify renamed note: {e}"))?;
    let mut hasher = Md5::new();
    hasher.update(&bytes);
    if original.last_md5 != format!("{:x}", hasher.finalize()) {
        return Ok(false);
    }
    let Some(existing_id) = ledger.by_name.get(new_name).cloned() else {
        ledger.by_name.remove(old_name);
        ledger.by_name.insert(new_name.to_string(), note_id.clone());
        if let Some(record) = ledger.notes.get_mut(&note_id) {
            record.name = new_name.to_string();
        }
        save_ledger(&path, &ledger)?;
        return Ok(true);
    };
    if existing_id == note_id {
        return Ok(false);
    }

    let is_duplicate = {
        let old_md5 = ledger
            .notes
            .get(&note_id)
            .map(|r| r.last_md5.clone())
            .unwrap_or_default();
        ledger
            .notes
            .get(&existing_id)
            .map(|r| {
                !r.last_md5.is_empty()
                    && r.last_md5 == old_md5
                    && r.bindings
                        .values()
                        .all(|b| b.state != AccountLinkState::Authorized)
            })
            .unwrap_or(false)
    };
    if !is_duplicate {
        return Ok(false);
    }

    // El registro duplicado se retira; la identidad original conserva sus permisos.
    if let Some(record) = ledger.notes.get_mut(&existing_id) {
        record.retired = true;
        record.missing_since = Some(now_ms());
    }
    ledger.by_name.remove(new_name);
    ledger.by_name.remove(old_name);
    ledger.by_name.insert(new_name.to_string(), note_id.clone());
    if let Some(record) = ledger.notes.get_mut(&note_id) {
        record.name = new_name.to_string();
    }
    save_ledger(&path, &ledger)?;
    Ok(true)
}

fn validate_pending_current(
    lyra_dir: &Path,
    ledger: &ProvenanceLedger,
    pending: &PendingAuthorization,
) -> Result<(), String> {
    for note in &pending.notes {
        let Some(note_id) = ledger.by_name.get(&note.name) else {
            return Err(format!(
                "La lista de notas cambió: '{}' ya no está disponible. Vuelve a sincronizar para revisar el estado actual",
                note.name
            ));
        };
        if note_id != &note.note_id {
            return Err(format!(
                "La lista de notas cambió: '{}' fue reemplazada por otra nota. Vuelve a sincronizar",
                note.name
            ));
        }
        let Some(record) = ledger.notes.get(note_id) else {
            return Err("La lista de notas cambió: falta información de una nota. Vuelve a sincronizar".to_string());
        };
        if record.retired {
            return Err(format!(
                "La lista de notas cambió: '{}' fue eliminada. Vuelve a sincronizar",
                note.name
            ));
        }

        // Revalidación contra el estado real del disco, no solo contra el libro.
        let path = lyra_dir.join(&note.name);
        let kind = fs::symlink_metadata(&path).map_err(|_| "A pending note is unavailable")?;
        if !kind.file_type().is_file() {
            return Err(format!("La nota '{}' ya no es un archivo local regular", note.name));
        }
        let metadata = fs::metadata(&path).map_err(|_| {
            format!(
                "La lista de notas cambió: '{}' ya no está disponible. Vuelve a sincronizar",
                note.name
            )
        })?;
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(-1);
        let size = metadata.len();
        if mtime != note.mtime || size != note.size {
            return Err(format!(
                "La lista de notas cambió: '{}' fue modificada después de la solicitud. Vuelve a sincronizar para revisar el estado actual",
                note.name
            ));
        }
        let bytes = fs::read(&path).map_err(|_| {
            format!(
                "La lista de notas cambió: no se pudo verificar '{}'. Vuelve a sincronizar",
                note.name
            )
        })?;
        let mut hasher = Md5::new();
        hasher.update(&bytes);
        let current_md5 = format!("{:x}", hasher.finalize());
        if record.last_md5 != current_md5 {
            return Err(format!(
                "La lista de notas cambió: '{}' fue modificada después de la solicitud. Vuelve a sincronizar para revisar el estado actual",
                note.name
            ));
        }
    }
    Ok(())
}

/// Aprueba explícitamente una solicitud de consentimiento concreta.
///
/// Revalida que cada nota siga siendo exactamente la misma que se mostró al
/// usuario. Si el conjunto cambió, no se autoriza nada.
pub fn authorize_selected_pending(
    lyra_dir: &Path,
    account_key: &str,
    request_id: &str,
    selected_ids: &[String],
    expected_epoch: u64,
) -> Result<usize, String> {
    let path = get_ledger_path(lyra_dir);
    let mut ledger = load_ledger(&path)?
        .ok_or_else(|| "No hay autorizaciones pendientes para esta cuenta".to_string())?;

    let pending = ledger
        .pending
        .get(account_key)
        .cloned()
        .ok_or_else(|| "No hay autorizaciones pendientes para esta cuenta".to_string())?;

    if pending.request_id != request_id {
        return Err(
            "La solicitud de autorización cambió. Actualiza la lista de notas e inténtalo de nuevo"
                .to_string(),
        );
    }
    if ledger.sessions.get(account_key).map(|session| session.epoch) != Some(expected_epoch)
        || compute_request_id(account_key, expected_epoch, &pending.notes) != request_id {
        return Err("La sesión o la solicitud de autorización cambió. Actualiza la lista".into());
    }

    let selected: BTreeSet<&str> = selected_ids.iter().map(String::as_str).collect();
    if selected.is_empty() || selected.len() != selected_ids.len() ||
        selected.iter().any(|id| !pending.notes.iter().any(|note| note.note_id == *id)) {
        return Err("La selección de notas no es válida para esta solicitud".to_string());
    }

    validate_pending_current(lyra_dir, &ledger, &pending)?;

    let now = now_ms();
    let count = selected.len();
    for note in pending.notes.iter().filter(|note| selected.contains(note.note_id.as_str())) {
        if ledger.notes.get(&note.note_id).and_then(|r| r.internal_welcome_sha256.as_ref()).is_some() {
            return Err("Una nota interna no puede autorizarse".into());
        }
        if let Some(record) = ledger.notes.get_mut(&note.note_id) {
            record.bindings.insert(
                account_key.to_string(),
                AccountBinding {
                    account_key: account_key.to_string(),
                    state: AccountLinkState::Authorized,
                    origin: NoteOrigin::Unknown,
                    source: AuthorizationSource::ExplicitConsent,
                    authorized_at: Some(now),
                    drive_id: record
                        .bindings
                        .get(account_key)
                        .and_then(|b| b.drive_id.clone()),
                    md5: Some(record.last_md5.clone()),
                },
            );
        }
    }

    if let Some(ids) = ledger.declined_note_ids.get_mut(account_key) {
        ids.retain(|id| !selected.contains(id.as_str()));
    }

    ledger.pending.remove(account_key);
    let remaining: Vec<PendingNote> = pending.notes.into_iter()
        .filter(|note| !selected.contains(note.note_id.as_str())).collect();
    if remaining.is_empty() {
        ledger.declined.remove(account_key);
    } else {
        let epoch = ledger.sessions.get(account_key).map(|s| s.epoch).unwrap_or_default();
        ledger.declined.insert(account_key.to_string(), compute_request_id(account_key, epoch, &remaining));
        ledger.declined_note_ids.entry(account_key.to_string()).or_default()
            .extend(remaining.iter().map(|note| note.note_id.clone()));
    }
    save_ledger(&path, &ledger)?;
    Ok(count)
}

#[cfg(test)]
pub fn authorize_pending(lyra_dir: &Path, account_key: &str, request_id: &str) -> Result<usize, String> {
    let ledger = load_ledger(&get_ledger_path(lyra_dir))?.ok_or("No ledger")?;
    let epoch = ledger.sessions.get(account_key).map(|session| session.epoch).unwrap_or_default();
    let pending = ledger.pending.get(account_key).cloned()
        .ok_or("No pending notes")?;
    authorize_selected_pending(lyra_dir, account_key, request_id,
        &pending.notes.iter().map(|note| note.note_id.clone()).collect::<Vec<_>>(), epoch)
}

/// Rechaza una solicitud concreta. No autoriza nada y no afecta al uso local.
pub fn decline_pending(
    lyra_dir: &Path,
    account_key: &str,
    request_id: &str,
) -> Result<(), String> {
    let path = get_ledger_path(lyra_dir);
    let Some(mut ledger) = load_ledger(&path)? else {
        return Ok(());
    };

    let Some(pending) = ledger.pending.get(account_key).cloned() else {
        return Ok(());
    };
    if pending.request_id != request_id {
        return Err(
            "La solicitud de autorización cambió. Actualiza la lista de notas e inténtalo de nuevo"
                .to_string(),
        );
    }

    ledger
        .declined
        .insert(account_key.to_string(), request_id.to_string());
    ledger.declined_note_ids.entry(account_key.to_string()).or_default()
        .extend(pending.notes.iter().map(|note| note.note_id.clone()));
    ledger.pending.remove(account_key);
    save_ledger(&path, &ledger)
}

/// Devuelve la solicitud pendiente de la cuenta, si existe.
pub fn load_pending_view(
    lyra_dir: &Path,
    account_key: &str,
) -> Result<Option<PendingAuthorizationView>, String> {
    let path = get_ledger_path(lyra_dir);
    let ledger = load_ledger(&path)?;
    Ok(ledger
        .and_then(|l| l.pending.get(account_key).cloned())
        .map(|p| p.to_view()))
}

/// Refreshes the account-specific local classification without contacting Drive.
/// An explicit management action may reopen a previously declined set.
pub fn inspect_local_notes(
    lyra_dir: &Path, account_key: &str, account_email: Option<String>, epoch: u64,
    manifest: &SyncManifest, reopen_declined: bool,
) -> Result<LocalNoteManagementView, String> {
    let mut ctx = SyncAccountContext::open(lyra_dir, account_key, account_email.clone(), epoch)?;
    let entries = fs::read_dir(lyra_dir).map_err(|e| format!("Cannot enumerate local notes: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot enumerate local notes: {e}"))?;
        let name = entry.file_name().into_string().map_err(|_| "A local note has an unreadable name")?;
        if name.starts_with('.') || !(name.ends_with(".txt") || name.ends_with(".md")) { continue; }
        if !entry.file_type().map_err(|e| format!("Cannot inspect '{name}': {e}"))?.is_file() {
            return Err(format!("Local note '{name}' is not a regular file"));
        }
        let bytes = fs::read(entry.path()).map_err(|e| format!("Cannot read '{name}': {e}"))?;
        let metadata = entry.metadata().map_err(|e| format!("Cannot inspect '{name}': {e}"))?;
        let mtime = metadata.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64).unwrap_or(-1);
        let mut hasher = Md5::new();
        hasher.update(&bytes);
        ctx.observe(&name, mtime, metadata.len(), &format!("{:x}", hasher.finalize()));
    }
    if reopen_declined {
        ctx.ledger.declined.remove(account_key);
        ctx.ledger.declined_note_ids.remove(account_key);
    }
    ctx.finish_scan(manifest);
    save_ledger(&ctx.path, &ctx.ledger)?;
    let mut notes = Vec::new();
    for note in ctx.scanned.values() {
        let status = if ctx.is_internal_welcome(&note.name) { "internal" }
            else if ctx.can_upload(&note.name) { "authorized" }
            else if ctx.ledger.pending.get(account_key).is_some_and(|p| p.notes.iter().any(|n| n.note_id == note.note_id)) { "pending" }
            else if ctx.ledger.declined_note_ids.get(account_key).is_some_and(|ids| ids.contains(&note.note_id)) { "declined" }
            else { "blocked" };
        notes.push(LocalNoteStatusView { note_id: note.note_id.clone(), name: note.name.clone(), status });
    }
    Ok(LocalNoteManagementView {
        account_key: account_key.to_string(), account_email, notes, request: ctx.pending_view(),
    })
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdrive::types::FileManifestItem;
    use md5::{Digest, Md5};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "lyra_prov_{label}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_note(dir: &Path, name: &str, content: &str) -> (i64, u64, String) {
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        let meta = fs::metadata(&path).unwrap();
        let mtime = meta
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let md5 = {
            let mut hasher = Md5::new();
            hasher.update(content.as_bytes());
            format!("{:x}", hasher.finalize())
        };
        (mtime, meta.len(), md5)
    }

    fn scan(ctx: &mut SyncAccountContext, dir: &Path, manifest: &SyncManifest) {
        let entries: Vec<String> = snapshot_note_names(dir).into_iter().collect();
        for name in entries {
            let content = fs::read(dir.join(&name)).unwrap();
            let meta = fs::metadata(dir.join(&name)).unwrap();
            let mtime = meta
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            let mut hasher = Md5::new();
            hasher.update(&content);
            let md5 = format!("{:x}", hasher.finalize());
            ctx.observe(&name, mtime, meta.len(), &md5);
        }
        ctx.finish_scan(manifest);
    }

    #[test]
    fn test_new_account_does_not_authorize_existing_notes() {
        let dir = TempDir::new("new_account");
        write_note(dir.path(), "Nota de A.txt", "contenido privado de A");

        let mut ctx = SyncAccountContext::open(dir.path(), "account_b", Some("b@x".into()), 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());

        assert!(!ctx.can_upload("Nota de A.txt"), "Una cuenta nueva no debe poder subir notas preexistentes");
        assert!(ctx.is_pending("Nota de A.txt"));
        let view = ctx.pending_view().expect("debe existir una solicitud pendiente");
        assert_eq!(view.note_count, 1);
        assert_eq!(view.notes.iter().map(|note| note.name.as_str()).collect::<Vec<_>>(), vec!["Nota de A.txt"]);
    }

    #[test]
    fn test_local_note_created_during_session_is_authorized() {
        let dir = TempDir::new("created");
        write_note(dir.path(), "Vieja.txt", "vieja");

        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        // Nota creada después de iniciar sesión.
        write_note(dir.path(), "Nueva.txt", "nueva de esta sesión");
        record_local_write(dir.path(), "Nueva.txt", Some("account_a"), true).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());

        assert!(ctx.can_upload("Nueva.txt"), "Una nota creada durante la sesión activa se autoriza");
        assert!(!ctx.can_upload("Vieja.txt"), "Una nota preexistente sigue requiriendo consentimiento");
    }

    #[test]
    fn external_creation_during_session_never_authorizes() {
        let dir = TempDir::new("external_new");
        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        write_note(dir.path(), "copied.md", "private content");
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        assert!(!ctx.can_upload("copied.md"));
        assert!(ctx.is_pending("copied.md"));
    }

    #[test]
    fn backend_creation_is_exclusive_and_account_scoped() {
        let dir = TempDir::new("exclusive_create");
        create_local_note(dir.path(), "created.md", b"from Lyra", Some("account_a")).unwrap();
        assert!(create_local_note(dir.path(), "created.md", b"replace", Some("account_b")).is_err());
        let mut a = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut a, dir.path(), &SyncManifest::default());
        assert!(a.can_upload("created.md"));
        a.persist().unwrap();
        let mut b = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        scan(&mut b, dir.path(), &SyncManifest::default());
        assert!(!b.can_upload("created.md"));
        assert_eq!(fs::read(dir.path().join("created.md")).unwrap(), b"from Lyra");
    }

    #[test]
    fn offline_creation_and_failed_ledger_write_do_not_grant_upload() {
        let dir = TempDir::new("offline_create");
        create_local_note(dir.path(), "offline.md", b"offline", None).unwrap();
        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        assert!(!ctx.can_upload("offline.md"));

        let failed = TempDir::new("failed_ledger");
        fs::create_dir(get_ledger_path(failed.path())).unwrap();
        create_local_note(failed.path(), "kept.md", b"kept", Some("account_a")).unwrap();
        assert_eq!(fs::read(failed.path().join("kept.md")).unwrap(), b"kept");
        fs::remove_dir(get_ledger_path(failed.path())).unwrap();
        let mut reopened = SyncAccountContext::open(failed.path(), "account_a", None, 1).unwrap();
        scan(&mut reopened, failed.path(), &SyncManifest::default());
        assert!(!reopened.can_upload("kept.md"));
    }

    #[test]
    fn external_replacement_same_name_and_size_retires_authorization() {
        let dir = TempDir::new("external_replace");
        create_local_note(dir.path(), "note.md", b"secret A", Some("account_a")).unwrap();
        let before = load_ledger(&get_ledger_path(dir.path())).unwrap().unwrap();
        let original_id = before.by_name["note.md"].clone();
        fs::remove_file(dir.path().join("note.md")).unwrap();
        fs::write(dir.path().join("note.md"), b"secret B").unwrap();
        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        assert!(!ctx.can_upload("note.md"));
        assert_ne!(ctx.ledger.by_name["note.md"], original_id);
        ctx.persist().unwrap();
        let mut after_restart = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut after_restart, dir.path(), &SyncManifest::default());
        assert!(!after_restart.can_upload("note.md"));
    }

    #[test]
    fn lyra_save_preserves_identity_after_atomic_replacement() {
        let dir = TempDir::new("trusted_save");
        create_local_note(dir.path(), "note.md", b"first", Some("account_a")).unwrap();
        let original_id = load_ledger(&get_ledger_path(dir.path())).unwrap().unwrap().by_name["note.md"].clone();
        super::super::sync::write_file_atomic(&dir.path().join("note.md"), b"second").unwrap();
        record_local_write(dir.path(), "note.md", None, false).unwrap();
        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        assert_eq!(ctx.ledger.by_name["note.md"], original_id);
        assert!(ctx.can_upload("note.md"));
    }

    #[test]
    fn backend_creation_survives_inflight_sync_persist() {
        let dir = TempDir::new("concurrent_create");
        let mut in_flight = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        create_local_note(dir.path(), "new.md", b"created", Some("account_a")).unwrap();
        in_flight.persist().unwrap();
        let mut reopened = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut reopened, dir.path(), &SyncManifest::default());
        assert!(reopened.can_upload("new.md"));
    }

    #[test]
    fn lyra_edit_of_externally_replaced_file_does_not_restore_old_grant() {
        let dir = TempDir::new("edit_replaced");
        create_local_note(dir.path(), "note.md", b"original", Some("account_a")).unwrap();
        fs::remove_file(dir.path().join("note.md")).unwrap();
        fs::write(dir.path().join("note.md"), b"external").unwrap();
        invalidate_changed_note(dir.path(), "note.md").unwrap();
        super::super::sync::write_file_atomic(&dir.path().join("note.md"), b"edited in Lyra").unwrap();
        record_local_write(dir.path(), "note.md", None, false).unwrap();
        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        assert!(!ctx.can_upload("note.md"));
    }

    #[test]
    fn test_explicit_consent_authorizes_concrete_notes() {
        let dir = TempDir::new("consent");
        write_note(dir.path(), "A.txt", "de la cuenta a");

        let mut ctx = SyncAccountContext::open(dir.path(), "account_b", Some("b@x".into()), 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        ctx.persist().unwrap();
        let view = ctx.pending_view().unwrap();

        let count = authorize_pending(dir.path(), "account_b", &view.request_id).unwrap();
        assert_eq!(count, 1);

        let mut reopened = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        scan(&mut reopened, dir.path(), &SyncManifest::default());
        assert!(reopened.can_upload("A.txt"));
        assert!(reopened.pending_view().is_none());
    }

    #[test]
    fn partial_consent_is_bound_to_ids_and_declines_only_unselected_notes() {
        let dir = TempDir::new("partial_consent");
        for name in ["A.txt", "B.txt", "C.md"] { write_note(dir.path(), name, name); }
        let view = inspect_local_notes(dir.path(), "account_b", Some("b@x".into()), 1,
            &SyncManifest::default(), false).unwrap();
        let request = view.request.unwrap();
        assert_eq!(request.notes.len(), 3);
        let chosen = request.notes[0].note_id.clone();
        assert!(authorize_selected_pending(dir.path(), "account_b", &request.request_id,
            &[chosen.clone(), chosen.clone()], 1).is_err());
        assert!(authorize_selected_pending(dir.path(), "account_b", &request.request_id,
            &["unknown".into()], 1).is_err());
        assert!(authorize_selected_pending(dir.path(), "account_b", &request.request_id,
            &[chosen], 2).is_err());
        assert_eq!(authorize_selected_pending(dir.path(), "account_b", &request.request_id,
            &[request.notes[0].note_id.clone()], 1).unwrap(), 1);
        let mut after = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        scan(&mut after, dir.path(), &SyncManifest::default());
        assert!(after.can_upload(&request.notes[0].name));
        for note in &request.notes[1..] { assert!(!after.can_upload(&note.name)); }
        assert!(after.pending_view().is_none());
        write_note(dir.path(), "D.txt", "new local note");
        let new_scan = inspect_local_notes(dir.path(), "account_b", None, 1,
            &SyncManifest::default(), false).unwrap();
        let only_new = new_scan.request.unwrap();
        assert_eq!(only_new.notes.iter().map(|note| note.name.as_str()).collect::<Vec<_>>(), vec!["D.txt"]);
        let managed = inspect_local_notes(dir.path(), "account_b", None, 1,
            &SyncManifest::default(), true).unwrap();
        assert_eq!(managed.request.unwrap().notes.len(), 3);
    }

    #[test]
    fn internal_welcome_requires_rust_identity_and_exact_saved_content() {
        let dir = TempDir::new("internal_welcome");
        let name = "¡Bienvenid@ a Lyra!.txt";
        create_local_note(dir.path(), name, b"original", None).unwrap();
        mark_internal_welcome(dir.path(), name, b"original").unwrap();
        let first = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap();
        assert_eq!(first.notes[0].status, "internal");
        assert!(first.request.is_none());
        record_local_write(dir.path(), name, None, false).unwrap();
        let reopened = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap();
        assert_eq!(reopened.notes[0].status, "internal");
        assert_eq!(authorized_deletion(dir.path(), name, "account_a", "remote-id").unwrap(), None);
        let renamed = "Renamed welcome.txt";
        fs::rename(dir.path().join(name), dir.path().join(renamed)).unwrap();
        assert!(rename_note(dir.path(), name, renamed).unwrap());
        assert!(is_verified_internal_welcome(dir.path(), renamed).unwrap());
        let renamed_view = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap();
        assert_eq!(renamed_view.notes[0].status, "internal");
        super::super::sync::write_file_atomic(&dir.path().join(renamed), b"personal").unwrap();
        record_local_write(dir.path(), renamed, None, false).unwrap();
        let changed = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap();
        assert_eq!(changed.notes[0].status, "pending");
        assert_eq!(changed.request.unwrap().notes.len(), 1);
    }

    #[test]
    fn same_named_legacy_note_remains_pending_without_internal_evidence() {
        let dir = TempDir::new("legacy_welcome");
        write_note(dir.path(), "¡Bienvenid@ a Lyra!.txt", "Bienvenido a Lyra");
        let view = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap();
        assert_eq!(view.notes[0].status, "pending");
        assert_eq!(view.request.unwrap().notes.len(), 1);
    }

    #[test]
    fn external_change_and_recreation_retire_internal_welcome_identity() {
        let dir = TempDir::new("welcome_external");
        let name = "¡Bienvenid@ a Lyra!.txt";
        create_local_note(dir.path(), name, b"original", None).unwrap();
        mark_internal_welcome(dir.path(), name, b"original").unwrap();
        let old_id = load_ledger(&get_ledger_path(dir.path())).unwrap().unwrap().by_name[name].clone();
        fs::write(dir.path().join(name), b"external change").unwrap();
        let changed = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap();
        assert_eq!(changed.notes[0].status, "pending");
        assert_ne!(changed.notes[0].note_id, old_id);
        retire_note(dir.path(), name).unwrap();
        fs::remove_file(dir.path().join(name)).unwrap();
        create_local_note(dir.path(), name, b"original", None).unwrap();
        let recreated = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap();
        assert_eq!(recreated.notes[0].status, "pending");
    }

    #[test]
    fn deleted_note_cannot_be_authorized_from_stale_request() {
        let dir = TempDir::new("stale_deleted_consent");
        write_note(dir.path(), "A.txt", "local");
        let request = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap().request.unwrap();
        fs::remove_file(dir.path().join("A.txt")).unwrap();
        assert!(authorize_selected_pending(dir.path(), "account_a", &request.request_id,
            &[request.notes[0].note_id.clone()], 1).is_err());
    }

    #[test]
    fn restored_session_reissues_request_for_current_process_epoch() {
        let dir = TempDir::new("restored_epoch");
        write_note(dir.path(), "A.txt", "local");
        let old = inspect_local_notes(dir.path(), "account_a", None, 8,
            &SyncManifest::default(), false).unwrap().request.unwrap();
        let current = inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).unwrap().request.unwrap();
        assert_ne!(old.request_id, current.request_id);
        assert!(authorize_selected_pending(dir.path(), "account_a", &old.request_id,
            &[old.notes[0].note_id.clone()], 1).is_err());
        assert_eq!(authorize_selected_pending(dir.path(), "account_a", &current.request_id,
            &[current.notes[0].note_id.clone()], 1).unwrap(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_note_blocks_management_instead_of_disappearing() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new("symlinked_note");
        let outside = TempDir::new("outside_note");
        write_note(outside.path(), "secret.txt", "fictional");
        symlink(outside.path().join("secret.txt"), dir.path().join("linked.txt")).unwrap();
        assert!(inspect_local_notes(dir.path(), "account_a", None, 1,
            &SyncManifest::default(), false).is_err());
        assert!(!get_ledger_path(dir.path()).exists());
    }

    #[test]
    fn test_consent_invalidated_when_note_changes() {
        let dir = TempDir::new("invalidated");
        write_note(dir.path(), "A.txt", "version 1");

        let mut ctx = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        ctx.persist().unwrap();
        let request_id = ctx.pending_view().unwrap().request_id;

        // La nota cambia después de mostrar la solicitud.
        std::thread::sleep(std::time::Duration::from_millis(5));
        write_note(dir.path(), "A.txt", "version 2 modificada");

        let err = authorize_pending(dir.path(), "account_b", &request_id).unwrap_err();
        assert!(err.contains("cambió"), "La aprobación debe rechazarse: {err}");

        let ledger = load_ledger(&get_ledger_path(dir.path())).unwrap().unwrap();
        let binding_authorized = ledger
            .notes
            .values()
            .any(|n| n.bindings.values().any(|b| b.state == AccountLinkState::Authorized));
        assert!(!binding_authorized, "No debe quedar ninguna autorización tras el rechazo");
    }

    #[test]
    fn test_decline_does_not_authorize_and_preserves_local_file() {
        let dir = TempDir::new("decline");
        write_note(dir.path(), "A.txt", "contenido local intacto");

        let mut ctx = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        ctx.persist().unwrap();
        let request_id = ctx.pending_view().unwrap().request_id;
        decline_pending(dir.path(), "account_b", &request_id).unwrap();

        assert!(dir.path().join("A.txt").exists(), "Rechazar no debe tocar el archivo local");
        let mut reopened = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        scan(&mut reopened, dir.path(), &SyncManifest::default());
        assert!(!reopened.can_upload("A.txt"));
        assert!(
            reopened.pending_view().is_none(),
            "Un rechazo con la misma lista no debe volver a preguntar en cada sincronización"
        );
    }

    #[test]
    fn test_download_authorizes_note_for_that_account_only() {
        let dir = TempDir::new("download");
        let (mtime, size, md5) = write_note(dir.path(), "Compartida.txt", "vino de B");

        let mut ctx = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        ctx.mark_downloaded("Compartida.txt", "drive_1", &md5, mtime, size, AuthorizationSource::AutomaticDownload);
        scan(&mut ctx, dir.path(), &SyncManifest::default());

        assert!(ctx.can_upload("Compartida.txt"));
        ctx.persist().unwrap();

        let mut other = SyncAccountContext::open(dir.path(), "account_c", None, 1).unwrap();
        scan(&mut other, dir.path(), &SyncManifest::default());
        assert!(!other.can_upload("Compartida.txt"), "La autorización no debe transferirse a otra cuenta");
    }

    #[test]
    fn test_legacy_manifest_evidence_authorizes_existing_install() {
        let dir = TempDir::new("legacy");
        let (mtime, size, md5) = write_note(dir.path(), "Legado.txt", "nota de una instalación previa");

        let mut manifest = SyncManifest::default();
        manifest.files.insert(
            "Legado.txt".to_string(),
            FileManifestItem {
                drive_id: "old_drive_id".to_string(),
                md5: md5.clone(),
                local_mtime: mtime,
                remote_mtime: "2026-01-01T00:00:00Z".to_string(),
                local_size: size,
            },
        );

        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut ctx, dir.path(), &manifest);
        assert!(ctx.can_upload("Legado.txt"));
        assert!(ctx.pending_view().is_none());
    }

    #[test]
    fn test_rename_preserves_authorization_and_retire_forces_new_identity() {
        let dir = TempDir::new("rename");

        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        write_note(dir.path(), "Original.txt", "contenido");
        record_local_write(dir.path(), "Original.txt", Some("account_a"), true).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        ctx.persist().unwrap();
        assert!(ctx.can_upload("Original.txt"));

        std::fs::rename(dir.path().join("Original.txt"), dir.path().join("Renombrada.txt")).unwrap();
        assert!(rename_note(dir.path(), "Original.txt", "Renombrada.txt").unwrap());
        let mut reopened = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        scan(&mut reopened, dir.path(), &SyncManifest::default());
        assert!(reopened.can_upload("Renombrada.txt"), "Renombrar conserva la autorización");

        retire_note(dir.path(), "Renombrada.txt").unwrap();
        assert!(std::fs::remove_file(dir.path().join("Renombrada.txt")).is_ok());
        write_note(dir.path(), "Renombrada.txt", "contenido recreado");

        // Otra cuenta que inicia sesión después de la recreación no hereda nada.
        let mut other = SyncAccountContext::open(dir.path(), "account_b", None, 1).unwrap();
        scan(&mut other, dir.path(), &SyncManifest::default());
        assert!(!other.can_upload("Renombrada.txt"), "Una recreación no hereda autorización de una identidad retirada");
        assert!(other.is_pending("Renombrada.txt"));
    }

    #[test]
    fn test_corrupt_ledger_fails_closed_and_recovers_from_backup() {
        let dir = TempDir::new("corrupt");
        fs::write(get_ledger_path(dir.path()), "{ esto no es json").unwrap();

        let err = SyncAccountContext::open(dir.path(), "account_a", None, 1)
            .expect_err("Un libro corrupto sin respaldo debe impedir la sincronización");
        assert!(err.contains("dañado"));

        // Con respaldo válido se recupera y se conserva la autorización previa.
        let valid = ProvenanceLedger::default();
        save_ledger(&dir.path().join(".lyra_provenance.json.bak"), &valid).unwrap();
        fs::write(get_ledger_path(dir.path()), "roto").unwrap();
        let recovered = SyncAccountContext::open(dir.path(), "account_a", None, 1);
        assert!(recovered.is_ok(), "Debe recuperarse desde el respaldo válido");
    }

    #[test]
    fn test_rename_adopts_concurrent_duplicate_without_losing_authorization() {
        let dir = TempDir::new("rename_race");

        // La cuenta A autoriza una nota creada durante su sesión.
        let mut ctx_a = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        write_note(dir.path(), "Original.txt", "contenido compartido");
        record_local_write(dir.path(), "Original.txt", Some("account_a"), true).unwrap();
        scan(&mut ctx_a, dir.path(), &SyncManifest::default());
        assert!(ctx_a.can_upload("Original.txt"));
        ctx_a.persist().unwrap();
        end_account_session(dir.path(), "account_a").unwrap();

        // El archivo se renombra y, antes de registrar el renombrado, la cuenta B
        // lo escanea y crea un registro duplicado pendiente de consentimiento.
        std::fs::rename(dir.path().join("Original.txt"), dir.path().join("Renombrada.txt")).unwrap();
        let mut ctx_b = SyncAccountContext::open(dir.path(), "account_b", None, 2).unwrap();
        scan(&mut ctx_b, dir.path(), &SyncManifest::default());
        ctx_b.persist().unwrap();
        assert!(ctx_b.is_pending("Renombrada.txt"));

        // El renombrado adopta el duplicado y conserva la autorización original.
        assert!(rename_note(dir.path(), "Original.txt", "Renombrada.txt").unwrap());

        let ledger = load_ledger(&get_ledger_path(dir.path())).unwrap().unwrap();
        let note_id = ledger.by_name.get("Renombrada.txt").unwrap();
        let record = ledger.notes.get(note_id).unwrap();
        assert!(!record.retired);
        assert!(
            record
                .bindings
                .get("account_a")
                .map(|b| b.state == AccountLinkState::Authorized)
                .unwrap_or(false),
            "La autorización de la cuenta A debe conservarse al renombrar"
        );
        assert!(
            !record
                .bindings
                .get("account_b")
                .map(|b| b.state == AccountLinkState::Authorized)
                .unwrap_or(false),
            "La cuenta B no hereda autorización"
        );
        assert_eq!(
            ledger.notes.values().filter(|r| !r.retired).count(),
            1,
            "Debe quedar una sola identidad viva para la nota"
        );
    }

    #[test]
    fn test_concurrent_retirement_survives_inflight_sync_persist() {
        let dir = TempDir::new("concurrent_retire");

        // La sesión comienza con el directorio vacío.
        let mut ctx = SyncAccountContext::open(dir.path(), "account_a", None, 1).unwrap();
        write_note(dir.path(), "A.txt", "creada durante la sesión");
        record_local_write(dir.path(), "A.txt", Some("account_a"), true).unwrap();
        scan(&mut ctx, dir.path(), &SyncManifest::default());
        assert!(ctx.can_upload("A.txt"));
        ctx.persist().unwrap();

        // Mientras la sincronización está en curso, el usuario elimina la nota y
        // la vuelve a crear con otro contenido.
        retire_note(dir.path(), "A.txt").unwrap();
        write_note(dir.path(), "A.txt", "recreada con otro contenido");
        ctx.persist().unwrap();

        // Al cerrar y volver a iniciar sesión, la nota recreada ya no está autorizada.
        end_account_session(dir.path(), "account_a").unwrap();
        let mut reopened = SyncAccountContext::open(dir.path(), "account_a", None, 2).unwrap();
        scan(&mut reopened, dir.path(), &SyncManifest::default());
        assert!(
            !reopened.can_upload("A.txt"),
            "Un retiro concurrente nunca debe perderse al persistir la sincronización"
        );
        assert!(reopened.is_pending("A.txt"));
    }
}

// ---------------------------------------------------------------------------
// Contexto de sincronización por cuenta
// ---------------------------------------------------------------------------

/// Contexto de autorización usado por un ciclo de sincronización completo.
///
/// Se abre al inicio del ciclo, observa las notas locales, decide qué puede
/// subirse a la cuenta activa y persiste el resultado al finalizar.
#[derive(Debug)]
pub struct SyncAccountContext {
    pub account_key: String,
    pub account_email: Option<String>,
    path: PathBuf,
    ledger: ProvenanceLedger,
    session_started_at: i64,
    session_epoch: u64,
    snapshot_names: BTreeSet<String>,
    scanned: BTreeMap<String, PendingNote>,
    dirty: bool,
}

impl SyncAccountContext {
    /// Abre el contexto para la cuenta indicada.
    ///
    /// Falla cerrado si el libro existe pero está corrupto y no hay respaldo.
    pub fn open(
        lyra_dir: &Path,
        account_key: &str,
        account_email: Option<String>,
        epoch: u64,
    ) -> Result<Self, String> {
        let path = get_ledger_path(lyra_dir);
        let mut ledger = load_ledger(&path)?.unwrap_or_default();

        let session = ledger
            .sessions
            .get(account_key)
            .filter(|s| s.ended_at.is_none() && s.epoch == epoch);

        let (session_started_at, session_epoch, snapshot_names) = match session {
            Some(existing) => (
                existing.started_at,
                existing.epoch,
                existing.snapshot_names.clone(),
            ),
            None => {
                let started_at = now_ms();
                let snapshot = snapshot_note_names(lyra_dir);
                ledger.sessions.insert(
                    account_key.to_string(),
                    AccountSession {
                        account_key: account_key.to_string(),
                        started_at,
                        ended_at: None,
                        epoch,
                        snapshot_names: snapshot.clone(),
                    },
                );
                (started_at, epoch, snapshot)
            }
        };

        Ok(Self {
            account_key: account_key.to_string(),
            account_email,
            path,
            ledger,
            session_started_at,
            session_epoch,
            snapshot_names,
            scanned: BTreeMap::new(),
            dirty: false,
        })
    }

    /// Contexto permisivo exclusivo de pruebas: simula que la sesión de la
    /// cuenta comenzó antes de que existieran las notas, de modo que las notas
    /// presentes en disco se consideran creadas durante la sesión.
    #[cfg(test)]
    pub fn open_test(lyra_dir: &Path, account_key: &str) -> Result<Self, String> {
        let path = get_ledger_path(lyra_dir);
        let mut ledger = load_ledger(&path)?.unwrap_or_default();
        ledger.sessions.insert(
            account_key.to_string(),
            AccountSession {
                account_key: account_key.to_string(),
                started_at: 0,
                ended_at: None,
                epoch: 0,
                snapshot_names: BTreeSet::new(),
            },
        );
        let mut ctx = Self {
            account_key: account_key.to_string(),
            account_email: None,
            path,
            ledger,
            session_started_at: 0,
            session_epoch: 0,
            snapshot_names: BTreeSet::new(),
            scanned: BTreeMap::new(),
            dirty: true,
        };
        // Legacy sync tests model local files produced by Lyra. Production
        // never uses this helper or grants authorization from a scan.
        for name in snapshot_note_names(lyra_dir) {
            let file_path = lyra_dir.join(&name);
            let bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
            let metadata = fs::metadata(&file_path).map_err(|e| e.to_string())?;
            let mtime = metadata.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64).unwrap_or(-1);
            let mut hasher = Md5::new();
            hasher.update(&bytes);
            let md5 = format!("{:x}", hasher.finalize());
            ctx.observe(&name, mtime, bytes.len() as u64, &md5);
            if let Some(id) = ctx.ledger.by_name.get(&name).cloned() {
                ctx.bind_authorized(&id, NoteOrigin::CreatedLocally,
                    AuthorizationSource::AutomaticLocalCreation, now_ms());
            }
        }
        Ok(ctx)
    }

    /// Registra una nota local observada durante el escaneo.
    pub fn observe(&mut self, name: &str, mtime: i64, size: u64, md5: &str) {
        let now = now_ms();
        // A Lyra save may have persisted after this context was opened.
        // Accept that trusted backend update only when it still names the same
        // logical note and matches the bytes being scanned.
        if let Ok(Some(disk)) = load_ledger(&self.path) {
            if !self.ledger.by_name.contains_key(name) {
                if let Some(disk_id) = disk.by_name.get(name) {
                    if let Some(disk_record) = disk.notes.get(disk_id) {
                        if !disk_record.retired && disk_record.last_md5 == md5 {
                            self.ledger.by_name.insert(name.to_string(), disk_id.clone());
                            self.ledger.notes.insert(disk_id.clone(), disk_record.clone());
                        }
                    }
                }
            }
            if let (Some(memory_id), Some(disk_id)) =
                (self.ledger.by_name.get(name), disk.by_name.get(name)) {
                if memory_id == disk_id {
                    if let Some(disk_record) = disk.notes.get(disk_id) {
                        if !disk_record.retired && disk_record.last_md5 == md5 {
                            self.ledger.notes.insert(disk_id.clone(), disk_record.clone());
                        }
                    }
                }
            }
        }
        let note_id = match self.ledger.by_name.get(name).cloned() {
            Some(existing_id) => {
                match self.ledger.notes.get(&existing_id) {
                    Some(record) if !record.retired && record.last_md5 == md5 &&
                        record.internal_welcome_sha256.as_ref().is_none_or(|expected|
                            fs::read(self.path.with_file_name(name))
                                .map(|bytes| format!("{:x}", Sha256::digest(&bytes)) == *expected)
                                .unwrap_or(false)) => existing_id,
                    Some(record) if !record.retired => {
                        if let Some(old) = self.ledger.notes.get_mut(&existing_id) {
                            old.retired = true;
                            old.missing_since = Some(now);
                        }
                        self.create_note(name, mtime, size, md5, now)
                    },
                    _ => self.create_note(name, mtime, size, md5, now),
                }
            }
            None => self.create_note(name, mtime, size, md5, now),
        };

        if let Some(record) = self.ledger.notes.get_mut(&note_id) {
            record.name = name.to_string();
            record.last_seen_mtime = mtime;
            record.last_size = size;
            record.last_md5 = md5.to_string();
            record.last_seen_at = now;
            record.missing_since = None;
            record.retired = false;
            self.scanned.insert(
                name.to_string(),
                PendingNote {
                    note_id: note_id.clone(),
                    name: name.to_string(),
                    mtime,
                    size,
                },
            );
        }
        self.ledger.by_name.insert(name.to_string(), note_id);
        self.dirty = true;
    }

    fn create_note(&mut self, name: &str, mtime: i64, size: u64, md5: &str, now: i64) -> String {
        let note_id = new_note_id();
        self.ledger.notes.insert(
            note_id.clone(),
            NoteRecord::new(note_id.clone(), name.to_string(), mtime, size, md5, now),
        );
        self.ledger.by_name.insert(name.to_string(), note_id.clone());
        self.dirty = true;
        note_id
    }

    /// Decide la autorización de cada nota observada para la cuenta activa.
    ///
    /// Evidencia que autoriza automáticamente:
    /// 1. La nota ya estaba autorizada para esta cuenta.
    /// 2. Coincide con una entrada del manifiesto de esta cuenta (migración).
    ///
    /// Cualquier otro caso queda pendiente de consentimiento explícito.
    pub fn finish_scan(&mut self, manifest: &SyncManifest) {
        let key = self.account_key.clone();
        let now = now_ms();
        let mut pending_notes: Vec<PendingNote> = Vec::new();

        let scanned: Vec<PendingNote> = self.scanned.values().cloned().collect();
        for pending in &scanned {
            if self.is_internal_welcome(&pending.name) {
                continue;
            }
            let already_authorized = self
                .ledger
                .notes
                .get(&pending.note_id)
                .and_then(|record| record.bindings.get(&key))
                .map(|binding| binding.state == AccountLinkState::Authorized)
                .unwrap_or(false);
            if already_authorized {
                continue;
            }

            let legacy_evidence = manifest
                .files
                .get(&pending.name)
                .map(|item| {
                    let record_md5 = self
                        .ledger
                        .notes
                        .get(&pending.note_id)
                        .map(|r| r.last_md5.clone())
                        .unwrap_or_default();
                    (!item.md5.is_empty() && item.md5 == record_md5)
                        || (item.md5.is_empty()
                            && item.local_mtime == pending.mtime
                            && item.local_size == pending.size)
                })
                .unwrap_or(false);

            if legacy_evidence && !self.has_foreign_authorization(&pending.name) {
                self.bind_authorized(&pending.note_id, NoteOrigin::LegacyManifest, AuthorizationSource::LegacyEvidence, now);
            } else {
                self.bind_pending(&pending.note_id, now);
                pending_notes.push(pending.clone());
            }
        }

        pending_notes.sort_by(|a, b| a.name.cmp(&b.name));

        // Migrate the old whole-request decline when the exact old set is seen.
        let old_request_id = compute_request_id(&key, self.session_epoch, &pending_notes);
        if self.ledger.declined.get(&key) == Some(&old_request_id) {
            self.ledger.declined_note_ids.entry(key.clone()).or_default()
                .extend(pending_notes.iter().map(|note| note.note_id.clone()));
        }
        if let Some(declined_ids) = self.ledger.declined_note_ids.get(&key) {
            pending_notes.retain(|note| !declined_ids.contains(&note.note_id));
        }

        if pending_notes.is_empty() {
            self.ledger.pending.remove(&key);
        } else {
            let request_id = compute_request_id(&key, self.session_epoch, &pending_notes);
            self.ledger.pending.insert(
                    key.clone(),
                    PendingAuthorization {
                        account_key: key.clone(),
                        account_email: self.account_email.clone(),
                        request_id,
                        notes: pending_notes,
                        created_at: now,
                    },
                );
        }

        // Marcar como ausentes las notas registradas que no aparecieron en este escaneo.
        let scanned_ids: BTreeSet<String> =
            self.scanned.values().map(|n| n.note_id.clone()).collect();
        for (id, record) in self.ledger.notes.iter_mut() {
            if !record.retired && !scanned_ids.contains(id) && record.missing_since.is_none() {
                record.missing_since = Some(now);
            }
        }

        self.dirty = true;
    }

    fn bind_authorized(
        &mut self,
        note_id: &str,
        origin: NoteOrigin,
        source: AuthorizationSource,
        now: i64,
    ) {
        let key = self.account_key.clone();
        if let Some(record) = self.ledger.notes.get_mut(note_id) {
            let binding = record
                .bindings
                .entry(key.clone())
                .or_insert(AccountBinding {
                    account_key: key,
                    state: AccountLinkState::Authorized,
                    origin,
                    source,
                    authorized_at: Some(now),
                    drive_id: None,
                    md5: None,
                });
            binding.state = AccountLinkState::Authorized;
            binding.origin = origin;
            binding.source = source;
            binding.authorized_at = Some(now);
            binding.md5 = Some(record.last_md5.clone());
        }
        self.dirty = true;
    }

    fn bind_pending(&mut self, note_id: &str, _now: i64) {
        let key = self.account_key.clone();
        if let Some(record) = self.ledger.notes.get_mut(note_id) {
            let binding = record
                .bindings
                .entry(key.clone())
                .or_insert(AccountBinding {
                    account_key: key,
                    state: AccountLinkState::Pending,
                    origin: NoteOrigin::Unknown,
                    source: AuthorizationSource::None,
                    authorized_at: None,
                    drive_id: None,
                    md5: None,
                });
            if binding.state != AccountLinkState::Authorized {
                binding.state = AccountLinkState::Pending;
            }
        }
        self.dirty = true;
    }

    /// ¿Puede esta nota subirse a la cuenta activa?
    pub fn can_upload(&self, name: &str) -> bool {
        if self.is_internal_welcome(name) { return false; }
        let Some(note_id) = self.ledger.by_name.get(name) else {
            return false;
        };
        let Some(record) = self.ledger.notes.get(note_id) else {
            return false;
        };
        if record.retired {
            return false;
        }
        record
            .bindings
            .get(&self.account_key)
            .map(|b| b.state == AccountLinkState::Authorized)
            .unwrap_or(false)
    }

    pub fn is_internal_welcome(&self, name: &str) -> bool {
        self.ledger.by_name.get(name)
            .and_then(|id| self.ledger.notes.get(id))
            .filter(|record| !record.retired)
            .and_then(|record| record.internal_welcome_sha256.as_ref())
            .is_some_and(|expected| fs::read(self.path.with_file_name(name))
                .map(|bytes| format!("{:x}", Sha256::digest(&bytes)) == *expected)
                .unwrap_or(false))
    }

    pub fn can_upload_digest(&self, name: &str, md5: &str) -> bool {
        self.can_upload(name)
            && self.scanned.contains_key(name)
            && self.ledger.by_name.get(name)
                .and_then(|id| self.ledger.notes.get(id))
                .map(|record| record.last_md5 == md5)
                .unwrap_or(false)
    }

    pub fn record_manifest_links(&mut self, manifest: &SyncManifest, uploaded: &[String]) {
        for name in uploaded {
            let Some(item) = manifest.files.get(name) else { continue };
            if !self.can_upload(name) { continue }
            if let Some(record) = self.ledger.by_name.get(name)
                .and_then(|id| self.ledger.notes.get_mut(id)) {
                if let Some(binding) = record.bindings.get_mut(&self.account_key) {
                    binding.drive_id = Some(item.drive_id.clone());
                    self.dirty = true;
                }
            }
        }
    }

    /// ¿Está esta nota pendiente de consentimiento para la cuenta activa?
    #[cfg(test)]
    pub fn is_pending(&self, name: &str) -> bool {
        let Some(note_id) = self.ledger.by_name.get(name) else {
            return false;
        };
        self.ledger
            .notes
            .get(note_id)
            .and_then(|r| r.bindings.get(&self.account_key))
            .map(|b| b.state == AccountLinkState::Pending)
            .unwrap_or(false)
    }

    /// Registra una nota descargada desde la cuenta activa (evidencia fuerte).
    pub fn mark_downloaded(
        &mut self,
        name: &str,
        drive_id: &str,
        md5: &str,
        mtime: i64,
        size: u64,
        source: AuthorizationSource,
    ) {
        let now = now_ms();
        let existing_id = self.ledger.by_name.get(name).cloned().filter(|id| {
            self.ledger.notes.get(id).map(|r| !r.retired &&
                r.bindings.get(&self.account_key)
                    .map(|b| b.state == AccountLinkState::Authorized).unwrap_or(false))
                .unwrap_or(false)
        });
        if let Some(id) = existing_id {
            if let Some(record) = self.ledger.notes.get_mut(&id) {
                record.last_seen_mtime = mtime;
                record.last_size = size;
                record.last_md5 = md5.to_string();
                record.last_seen_at = now;
                record.missing_since = None;
            }
            self.scanned.insert(name.to_string(), PendingNote {
                note_id: id, name: name.to_string(), mtime, size,
            });
        } else {
            self.observe(name, mtime, size, md5);
        }
        let note_id = match self.ledger.by_name.get(name).cloned() {
            Some(id) => id,
            None => return,
        };
        if let Some(record) = self.ledger.notes.get_mut(&note_id) {
            record.bindings.insert(
                self.account_key.clone(),
                AccountBinding {
                    account_key: self.account_key.clone(),
                    state: AccountLinkState::Authorized,
                    origin: NoteOrigin::Downloaded,
                    source,
                    authorized_at: Some(now),
                    drive_id: Some(drive_id.to_string()),
                    md5: Some(md5.to_string()),
                },
            );
        }
        self.dirty = true;
    }

    /// ¿Existe otra cuenta autorizada para esta nota? En ese caso una descarga
    /// de la cuenta activa no debe sobrescribir el archivo local.
    pub fn has_foreign_authorization(&self, name: &str) -> bool {
        let Some(note_id) = self.ledger.by_name.get(name) else {
            return false;
        };
        let Some(record) = self.ledger.notes.get(note_id) else {
            return false;
        };
        record
            .bindings
            .iter()
            .any(|(key, binding)| {
                key != &self.account_key && binding.state == AccountLinkState::Authorized
            })
    }

    /// Retira una nota (eliminación local intencional). Su contenido deja de
    /// estar asociado a la cuenta; una recreación con el mismo nombre recibe
    /// una identidad nueva y requiere autorización si no nació en la sesión.
    pub fn retire(&mut self, name: &str) {
        let now = now_ms();
        let Some(note_id) = self.ledger.by_name.remove(name) else {
            return;
        };
        if let Some(record) = self.ledger.notes.get_mut(&note_id) {
            record.retired = true;
            record.missing_since = Some(now);
        }
        self.scanned.remove(name);
        self.dirty = true;
    }

    /// Elimina del conjunto pendiente las notas que ya quedaron autorizadas y
    /// recalcula la firma de la solicitud.
    fn refresh_pending(&mut self) {
        let key = self.account_key.clone();
        let Some(pending) = self.ledger.pending.get(&key).cloned() else {
            return;
        };
        let remaining: Vec<PendingNote> = pending
            .notes
            .into_iter()
            .filter(|note| {
                if self.ledger.declined_note_ids.get(&key).is_some_and(|ids| ids.contains(&note.note_id)) {
                    return false;
                }
                !self
                    .ledger
                    .notes
                    .get(&note.note_id)
                    .and_then(|r| r.bindings.get(&key))
                    .map(|b| b.state == AccountLinkState::Authorized)
                    .unwrap_or(false)
            })
            .collect();

        if remaining.is_empty() {
            self.ledger.pending.remove(&key);
        } else {
            let request_id = compute_request_id(&key, self.session_epoch, &remaining);
            if self.ledger.declined.get(&key) == Some(&request_id) {
                // El usuario rechazó exactamente este conjunto: no se vuelve a preguntar.
                self.ledger.pending.remove(&key);
            } else if let Some(entry) = self.ledger.pending.get_mut(&key) {
                entry.request_id = request_id;
                entry.notes = remaining;
            }
        }
    }

    /// Fusiona en memoria los cambios que otros comandos (eliminación de nota,
    /// renombrado, consentimiento explícito o rechazo) escribieron en disco
    /// mientras esta sincronización estaba en curso.
    ///
    /// Regla: los cambios de otro comando nunca se pierden al persistir. Un
    /// retiro concurrente gana siempre, de modo que borrar y recrear una nota no
    /// hereda la autorización anterior.
    fn merge_disk_state(&mut self, disk: ProvenanceLedger) {
        let now = now_ms();

        // 0. Un inicio de sesión concurrente (misma cuenta, sesión más nueva)
        //    reemplaza la sesión en memoria: cada login reinicia el snapshot.
        if let Some(disk_session) = disk.sessions.get(&self.account_key) {
            if disk_session.started_at > self.session_started_at {
                self.session_started_at = disk_session.started_at;
                self.session_epoch = disk_session.epoch;
                self.snapshot_names = disk_session.snapshot_names.clone();
                self.ledger
                    .sessions
                    .insert(self.account_key.clone(), disk_session.clone());
            }
        }

        // 1. Retiros y autorizaciones concedidas concurrentemente.
        for (note_id, disk_record) in disk.notes.iter() {
            let Some(record) = self.ledger.notes.get_mut(note_id) else {
                // A backend create may have happened after this sync opened.
                self.ledger.notes.insert(note_id.clone(), disk_record.clone());
                continue;
            };
            if disk_record.retired && !record.retired {
                record.retired = true;
                record.missing_since = disk_record.missing_since.or(Some(now));
            }
            if !disk_record.retired && disk_record.last_seen_at >= record.last_seen_at
                && disk_record.last_md5 != record.last_md5 {
                record.last_md5 = disk_record.last_md5.clone();
                record.last_seen_mtime = disk_record.last_seen_mtime;
                record.last_size = disk_record.last_size;
                record.last_seen_at = disk_record.last_seen_at;
            }
            if disk_record.last_seen_at >= record.last_seen_at {
                record.internal_welcome_sha256 = disk_record.internal_welcome_sha256.clone();
            }
            for (key, disk_binding) in disk_record.bindings.iter() {
                let already_authorized = record
                    .bindings
                    .get(key)
                    .map(|b| b.state == AccountLinkState::Authorized)
                    .unwrap_or(false);
                if disk_binding.state == AccountLinkState::Authorized && !already_authorized {
                    record.bindings.insert(key.clone(), disk_binding.clone());
                }
            }
        }

        // 2. Identidad por nombre: un nombre solo puede apuntar a una nota viva.
        for (name, note_id) in disk.by_name.iter() {
            let disk_alive = disk
                .notes
                .get(note_id)
                .map(|r| !r.retired)
                .unwrap_or(false);
            if !disk_alive {
                if self.ledger.by_name.get(name) == Some(note_id) {
                    self.ledger.by_name.remove(name);
                }
                continue;
            }
            let mem_alive = self
                .ledger
                .by_name
                .get(name)
                .and_then(|id| self.ledger.notes.get(id))
                .map(|r| !r.retired)
                .unwrap_or(false);
            if !mem_alive {
                self.ledger.by_name.insert(name.clone(), note_id.clone());
            }
        }

        // 3. Un renombrado concurrente mueve la identidad a otro nombre.
        let disk_name_by_id: BTreeMap<String, String> = disk
            .by_name
            .iter()
            .map(|(name, id)| (id.clone(), name.clone()))
            .collect();
        self.ledger.by_name.retain(|name, id| match disk_name_by_id.get(id) {
            Some(disk_name) => disk_name == name,
            None => true,
        });

        // 4. Decisions made while HTTP was in flight take precedence, including
        // an explicit reopening of previously declined notes.
        match disk.declined.get(&self.account_key) {
            Some(request_id) => { self.ledger.declined.insert(self.account_key.clone(), request_id.clone()); }
            None => { self.ledger.declined.remove(&self.account_key); }
        }
        match disk.declined_note_ids.get(&self.account_key) {
            Some(ids) => { self.ledger.declined_note_ids.insert(self.account_key.clone(), ids.clone()); }
            None => { self.ledger.declined_note_ids.remove(&self.account_key); }
        }
        for (key, ids) in disk.declined_note_ids.iter() {
            if key != &self.account_key { self.ledger.declined_note_ids.entry(key.clone()).or_default().extend(ids.iter().cloned()); }
        }

        // 5. Un nombre nunca debe quedar apuntando a una nota retirada.
        let retired_ids: BTreeSet<String> = self
            .ledger
            .notes
            .iter()
            .filter(|(_, record)| record.retired)
            .map(|(id, _)| id.clone())
            .collect();
        self.ledger
            .by_name
            .retain(|_, note_id| !retired_ids.contains(note_id));

        self.dirty = true;
    }

    /// Persiste el libro de procedencia si hubo cambios.
    pub fn persist(&mut self) -> Result<(), String> {
        // Re-fusionar lo que otros comandos hayan escrito durante la sincronización.
        if self.path.exists() {
            if let Some(disk) = load_ledger(&self.path)? {
                self.merge_disk_state(disk);
            }
        }
        self.refresh_pending();
        if !self.dirty && !self.path.exists() {
            self.dirty = true;
        }
        save_ledger(&self.path, &self.ledger)?;
        self.dirty = false;
        Ok(())
    }

    pub fn pending_view(&self) -> Option<PendingAuthorizationView> {
        self.ledger
            .pending
            .get(&self.account_key)
            .map(|p| p.to_view())
    }
}
