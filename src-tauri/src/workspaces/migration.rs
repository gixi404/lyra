//! Recoverable migration of the legacy notes folder into the first workspace.
//!
//! The migration is a small state machine driven by a journal:
//!
//! `Preparing` -> `Copied` -> `Prepared` -> `Activated` -> `Retired`
//!
//! * Nothing is ever overwritten: an existing destination with other content
//!   becomes a `DestinationConflict` that needs an explicit decision.
//! * Origins are never deleted: they are moved to `rescatados/`.
//! * The gate is only open when every item is either copied or explicitly
//!   deferred, and no new note appeared in the root meanwhile.
//! * A deferred note stays in the root and keeps being reported as pending.
//! * Retire conflicts keep the original in place, are reported, and do not
//!   block startup.
//!
//! All functions are synchronous and Tauri-free so they can be tested against
//! temporary directories; the command layer wraps them in blocking tasks.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::origins::{self, OriginEntry, OriginsLedger, Stamp};
use crate::gdrive::archive;
use super::paths;
use super::registry;
use super::types::{
    Workspace, WorkspaceKind, WorkspaceMarker, WritePolicy, DEFAULT_WORKSPACE_NAME, SCHEMA_VERSION,
};

pub const JOURNAL_SCHEMA: u32 = 2;
/// Serializes every mutation of the journal on disk.
pub static JOURNAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Preparing,
    Copied,
    Prepared,
    Activated,
    Retired,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    #[default]
    Pending,
    /// The source was copied under a different name because the destination
    /// already held other content.
    KeepBoth,
    /// The existing destination wins; the source is retired to `rescatados/`
    /// so both versions survive.
    AdoptDestination,
    /// The note stays in the root and is reported until the user imports it.
    Deferred,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub name: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub dest_name: Option<String>,
    #[serde(default)]
    pub decision: Decision,
    #[serde(default)]
    pub origin: Stamp,
    /// Stamp of the copy we wrote, used as a fast path for status checks.
    #[serde(default)]
    pub dest: Option<Stamp>,
    #[serde(default)]
    pub note: Option<String>,
}

impl Item {
    pub fn dest(&self) -> String {
        self.dest_name
            .clone()
            .unwrap_or_else(|| self.name.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetiredEntry {
    pub name: String,
    pub dest_name: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetireConflict {
    pub name: String,
    pub reason: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetireResolution {
    pub name: String,
    pub action: String,
    pub at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RetireReport {
    pub completed_at: i64,
    /// `lyra/rescatados/migracion-<stamp>`, relative to Documents.
    pub directory: String,
    #[serde(default)]
    pub retired: Vec<RetiredEntry>,
    #[serde(default)]
    pub conflicts: Vec<RetireConflict>,
    #[serde(default)]
    pub resolved: Vec<RetireResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub schema_version: u32,
    pub migration_id: String,
    pub phase: Phase,
    pub workspace_id: String,
    pub workspace_name: String,
    pub started_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub archived_names: Vec<String>,
    #[serde(default)]
    pub archive_ledger_present: bool,
    #[serde(default)]
    pub retire: Option<RetireReport>,
    #[serde(default)]
    pub error: Option<String>,
}

impl Journal {
    pub fn done(&self) -> bool {
        self.phase == Phase::Retired
    }
}

#[derive(Debug, Clone)]
pub struct Ctx {
    pub documents: PathBuf,
    pub config: PathBuf,
}

impl Ctx {
    pub fn new(documents: PathBuf, config: PathBuf) -> Self {
        Self { documents, config }
    }

    pub fn root(&self) -> PathBuf {
        paths::lyra_root(&self.documents)
    }

    pub fn workspace_dir(&self, id: &str) -> Result<PathBuf, String> {
        paths::workspace_dir(&self.documents, id)
    }

    pub fn journal_path(&self) -> PathBuf {
        paths::journal_path(&self.documents)
    }
}

/// Failure injection for tests. Production always uses [`Faults::none`].
#[derive(Debug, Clone, Default)]
pub struct Faults {
    pub fail_copy: Option<String>,
    pub fail_retire: Option<String>,
}

impl Faults {
    pub fn none() -> Self {
        Self::default()
    }

    fn blocks_copy(&self, name: &str) -> bool {
        self.fail_copy.as_deref() == Some(name)
    }

    fn blocks_retire(&self, name: &str) -> bool {
        self.fail_retire.as_deref() == Some(name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Copied,
    PendingCopy,
    DestinationConflict,
    SourceChanged,
    SourceMissing,
    SourceSymlink,
    Deferred,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub name: String,
    pub dest_name: String,
    pub status: ItemStatus,
    pub decision: Decision,
    pub detail: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub name: String,
    pub status: ItemStatus,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrayView {
    pub name: String,
    /// True for journal items the user chose to leave in the root.
    pub deferred: bool,
    /// A regular file that can be imported. Symlinks and vanished files are
    /// reported but never offered for import.
    pub importable: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub open: bool,
    pub blocks: Vec<Block>,
    pub strays: Vec<String>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn new_migration_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn status_detail(status: ItemStatus) -> &'static str {
    match status {
        ItemStatus::Copied => "Copiada en el espacio de trabajo",
        ItemStatus::PendingCopy => "Pendiente de copia",
        ItemStatus::DestinationConflict => {
            "Ya existe un archivo con contenido distinto en el espacio de trabajo"
        }
        ItemStatus::SourceChanged => "La nota original cambió después de preparar la migración",
        ItemStatus::SourceMissing => "La nota original ya no existe en la carpeta principal",
        ItemStatus::SourceSymlink => "La nota es un enlace simbólico y no se sigue",
        ItemStatus::Deferred => "Diferida: permanece intacta en la carpeta principal",
    }
}

fn backup_path(ctx: &Ctx) -> PathBuf {
    ctx.journal_path()
        .with_file_name(format!("{}.bak", paths::JOURNAL_FILE))
}

fn parse_journal(bytes: &[u8]) -> Result<Journal, String> {
    let journal: Journal = serde_json::from_slice(bytes)
        .map_err(|e| format!("El diario de migración está dañado: {e}"))?;
    if journal.schema_version != JOURNAL_SCHEMA {
        return Err(format!(
            "Versión de diario de migración no soportada: {}",
            journal.schema_version
        ));
    }
    super::ids::validate_id(&journal.workspace_id)?;
    Ok(journal)
}

/// Loads the journal, falling back to the backup and finally to the origins
/// ledger. Never invents anything that was not recorded.
pub fn load(ctx: &Ctx) -> Result<Option<Journal>, String> {
    let primary = ctx.journal_path();
    let bytes = match fs::read(&primary) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("No se pudo leer el diario de migración: {error}")),
    };
    if let Some(bytes) = bytes {
        match parse_journal(&bytes) {
            Ok(journal) => return Ok(Some(journal)),
            Err(error) => {
                if let Ok(backup) = fs::read(backup_path(ctx)) {
                    if let Ok(journal) = parse_journal(&backup) {
                        eprintln!("[workspaces] Diario recuperado desde la copia: {error}");
                        return Ok(Some(journal));
                    }
                }
                if let Some(ledger) = origins::load_ledger(&ctx.documents)? {
                    eprintln!("[workspaces] Diario reconstruido desde orígenes: {error}");
                    return Ok(Some(recover_from_ledger(ctx, ledger)?));
                }
                return Err(error);
            }
        }
    }
    Ok(None)
}

fn recover_from_ledger(ctx: &Ctx, ledger: OriginsLedger) -> Result<Journal, String> {
    if ledger.workspace_id.is_empty() {
        return Err("El registro de orígenes no identifica un espacio de trabajo".to_string());
    }
    super::ids::validate_id(&ledger.workspace_id)?;
    let items = ledger
        .entries
        .iter()
        .map(|entry| Item {
            name: entry.name.clone(),
            sha256: entry.sha256.clone(),
            size: entry.size,
            dest_name: entry.dest_name.clone(),
            decision: Decision::Pending,
            origin: entry.stamp,
            dest: None,
            note: None,
        })
        .collect();
    let archived_names = archive::projection(&ctx.root(), None)?.archived_names;
    let archive_ledger_present = ctx.root().join(".lyra_archive_state.json").is_file();
    Ok(Journal {
        schema_version: JOURNAL_SCHEMA,
        migration_id: ledger.migration_id,
        phase: Phase::Preparing,
        workspace_id: ledger.workspace_id,
        workspace_name: DEFAULT_WORKSPACE_NAME.to_string(),
        started_at: now_ms(),
        updated_at: now_ms(),
        items,
        archived_names,
        archive_ledger_present,
        retire: None,
        error: Some("El diario se reconstruyó desde .lyra_fs_origins.json".to_string()),
    })
}

/// Persists the journal and, with it, the origins ledger. The ledger is the
/// recovery source of truth: it always describes the *current* content each
/// item is responsible for, so a damaged journal can be rebuilt from it.
pub fn save(ctx: &Ctx, journal: &mut Journal) -> Result<(), String> {
    journal.updated_at = now_ms();
    let bytes = serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?;
    let path = ctx.journal_path();
    if let Ok(previous) = fs::read(&path) {
        if parse_journal(&previous).is_ok() {
            let _ = fs::write(backup_path(ctx), &previous);
        }
    }
    paths::write_atomic(&path, &bytes)?;
    save_ledger(ctx, journal)
}

fn save_ledger(ctx: &Ctx, journal: &Journal) -> Result<(), String> {
    let ledger = OriginsLedger {
        schema_version: origins::LEDGER_SCHEMA,
        migration_id: journal.migration_id.clone(),
        workspace_id: journal.workspace_id.clone(),
        entries: journal
            .items
            .iter()
            .filter(|item| !item.sha256.is_empty())
            .map(|item| OriginEntry {
                name: item.name.clone(),
                sha256: item.sha256.clone(),
                size: item.size,
                dest_name: item.dest_name.clone(),
                stamp: item.origin,
            })
            .collect(),
    };
    origins::save_ledger(&ctx.documents, &ledger)
}

fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    JOURNAL_LOCK
        .lock()
        .map_err(|_| "No se pudo acceder al estado de la migración".to_string())
}

/// Content plus a stable stamp, retried when the file changes mid-read.
fn hash_stable(path: &Path) -> Result<(String, u64, Stamp), String> {
    for _ in 0..3 {
        let before = origins::modified(path)?;
        let (hash, size) = origins::hash_file(path)?;
        let after = origins::modified(path)?;
        if before == after {
            return Ok((hash, size, after));
        }
    }
    Err(format!(
        "'{}' cambió mientras se preparaba la migración; vuelve a intentarlo",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("?")
    ))
}

/// Re-reads the current content of an item's original, when it is still a
/// regular file. Used only when the user explicitly decides to migrate the
/// content as it is now (`KeepBoth` / `Retry`), so an edit is never picked up
/// silently.
fn refresh_source(ctx: &Ctx, item: &mut Item) -> Result<(), String> {
    let source = ctx.root().join(&item.name);
    let metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(());
    }
    let (hash, size, stamp) = hash_stable(&source)?;
    item.sha256 = hash;
    item.size = size;
    item.origin = stamp;
    Ok(())
}

fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    }
}

/// First free name in `dir`, preserving the extension.
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, extension) = split_name(name);
    for counter in 2..10_000u32 {
        let candidate = dir.join(format!("{stem} ({counter}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!(
        "{stem} ({}){extension}",
        rand::random::<u32>()
    ))
}

/// Creates the backup name exclusively. A crash before unlinking the source
/// leaves two accessible links, never an overwritten backup or a lost note.
fn move_no_clobber(source: &Path, directory: &Path, name: &str) -> Result<PathBuf, String> {
    for _ in 0..10_000 {
        let target = unique_in(directory, name);
        match fs::hard_link(source, &target) {
            Ok(()) => {
                fs::remove_file(source).map_err(|e| {
                    format!("La copia original permanece en la raíz: {e}")
                })?;
                return Ok(target);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("No se pudo reservar un respaldo sin sobrescribir: {e}")),
        }
    }
    Err("No se encontró un nombre libre para el respaldo".to_string())
}

fn unique_name(dir: &Path, name: &str) -> String {
    unique_in(dir, name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(name)
        .to_string()
}

/// Copies `source` to `temporary` while hashing, so the content is read once.
fn copy_with_hash(source: &Path, temporary: &Path) -> Result<(String, u64), String> {
    let mut input = fs::File::open(source)
        .map_err(|e| format!("No se pudo abrir '{}': {e}", source.display()))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(|e| format!("No se pudo crear la copia temporal: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|e| format!("No se pudo leer '{}': {e}", source.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|e| format!("No se pudo escribir la copia: {e}"))?;
        size += read as u64;
    }
    output
        .sync_all()
        .map_err(|e| format!("No se pudo sincronizar la copia: {e}"))?;
    Ok((format!("{:x}", hasher.finalize()), size))
}

/// Moves `temporary` to `destination` without replacing an existing file.
fn place_no_clobber(temporary: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        let _ = fs::remove_file(temporary);
        return Err(format!(
            "'{}' ya existe; no se sobrescribe",
            destination.display()
        ));
    }
    if fs::hard_link(temporary, destination).is_ok() {
        let _ = fs::remove_file(temporary);
        return Ok(());
    }
    // Filesystems without hard links: the previous existence check is the
    // guard, and this process is the only writer while the gate is closed.
    if destination.exists() {
        let _ = fs::remove_file(temporary);
        return Err(format!(
            "'{}' ya existe; no se sobrescribe",
            destination.display()
        ));
    }
    fs::rename(temporary, destination).map_err(|e| {
        let _ = fs::remove_file(temporary);
        format!("No se pudo colocar '{}': {e}", destination.display())
    })
}

fn dest_matches(item: &Item, metadata: &fs::Metadata) -> bool {
    item.dest
        .as_ref()
        .is_some_and(|stamp| origins::unchanged(stamp, metadata))
}

fn evaluate(ctx: &Ctx, journal: &Journal, item: &Item) -> Result<ItemStatus, String> {
    if item.decision == Decision::Deferred {
        return Ok(ItemStatus::Deferred);
    }
    let source = ctx.root().join(&item.name);
    let metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ItemStatus::SourceMissing)
        }
        Err(error) => return Err(format!("No se pudo inspeccionar '{}': {error}", item.name)),
    };
    if metadata.file_type().is_symlink() {
        return Ok(ItemStatus::SourceSymlink);
    }
    if !origins::unchanged(&item.origin, &metadata) {
        let (hash, _) = origins::hash_file(&source)?;
        if hash != item.sha256 {
            return Ok(ItemStatus::SourceChanged);
        }
    }
    let destination = ctx.workspace_dir(&journal.workspace_id)?.join(item.dest());
    let destination_metadata = match fs::metadata(&destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ItemStatus::PendingCopy)
        }
        Err(error) => {
            return Err(format!(
                "No se pudo inspeccionar '{}': {error}",
                destination.display()
            ))
        }
    };
    if item.decision == Decision::AdoptDestination || dest_matches(item, &destination_metadata) {
        return Ok(ItemStatus::Copied);
    }
    let (hash, _) = origins::hash_file(&destination)?;
    if hash == item.sha256 {
        Ok(ItemStatus::Copied)
    } else {
        Ok(ItemStatus::DestinationConflict)
    }
}

fn note_for(item: &mut Item, status: ItemStatus) {
    item.note = match status {
        ItemStatus::Copied => None,
        ItemStatus::Deferred => Some(status_detail(ItemStatus::Deferred).to_string()),
        other => Some(status_detail(other).to_string()),
    };
}

pub fn statuses(ctx: &Ctx, journal: &Journal) -> Result<Vec<ItemView>, String> {
    let mut views = Vec::with_capacity(journal.items.len());
    for item in &journal.items {
        let status = evaluate(ctx, journal, item)?;
        views.push(ItemView {
            name: item.name.clone(),
            dest_name: item.dest(),
            status,
            decision: item.decision,
            detail: item.note.clone().or_else(|| Some(status_detail(status).to_string())),
            size: item.size,
        });
    }
    Ok(views)
}

/// Notes present in the root that the journal does not know about. Symlinks
/// are included so they can be reported, but they never block the gate.
fn unknown_root_entries(ctx: &Ctx, journal: &Journal) -> Result<Vec<paths::NoteEntry>, String> {
    let known: HashSet<&str> = journal
        .items
        .iter()
        .map(|item| item.name.as_str())
        .collect();
    Ok(paths::scan_notes(&ctx.root())?
        .into_iter()
        .filter(|entry| !known.contains(entry.name.as_str()))
        .collect())
}

pub fn strays(ctx: &Ctx, journal: &Journal) -> Result<Vec<StrayView>, String> {
    let mut views: Vec<StrayView> = unknown_root_entries(ctx, journal)?
        .into_iter()
        .map(|entry| StrayView {
            name: entry.name,
            deferred: entry.symlink,
            importable: !entry.symlink,
            detail: entry
                .symlink
                .then(|| "Enlace simbólico: no se sigue ni se importa".to_string()),
        })
        .collect();
    for item in journal
        .items
        .iter()
        .filter(|item| item.decision == Decision::Deferred)
    {
        // Deferred items may be symlinks: only a real file can be imported.
        let importable = fs::symlink_metadata(ctx.root().join(&item.name))
            .map(|metadata| metadata.file_type().is_file())
            .unwrap_or(false);
        views.push(StrayView {
            name: item.name.clone(),
            deferred: true,
            importable,
            detail: item
                .note
                .clone()
                .or_else(|| Some(status_detail(ItemStatus::Deferred).to_string())),
        });
    }
    views.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(views)
}

pub fn gate(ctx: &Ctx, journal: &Journal) -> Result<Gate, String> {
    let mut blocks = Vec::new();
    for view in statuses(ctx, journal)? {
        if view.decision == Decision::Deferred || view.status == ItemStatus::Copied {
            continue;
        }
        blocks.push(Block {
            name: view.name,
            status: view.status,
            detail: view.detail.unwrap_or_else(|| status_detail(view.status).to_string()),
        });
    }
    let strays: Vec<String> = unknown_root_entries(ctx, journal)?
        .into_iter()
        .filter(|entry| !entry.symlink)
        .map(|entry| entry.name)
        .collect();
    Ok(Gate {
        open: blocks.is_empty() && strays.is_empty(),
        blocks,
        strays,
    })
}

fn write_workspace_marker(ctx: &Ctx, journal: &Journal) -> Result<PathBuf, String> {
    let directory = ctx.workspace_dir(&journal.workspace_id)?;
    fs::create_dir_all(&directory)
        .map_err(|e| format!("No se pudo crear el espacio de trabajo: {e}"))?;
    match paths::read_marker(&directory)? {
        Some(existing) if existing.workspace_id != journal.workspace_id => {
            return Err(
                "El marcador del espacio de trabajo pertenece a otro espacio; no se sobrescribe"
                    .to_string(),
            )
        }
        _ => {}
    }
    let marker = WorkspaceMarker {
        schema_version: SCHEMA_VERSION,
        workspace_id: journal.workspace_id.clone(),
        name: journal.workspace_name.clone(),
        kind: WorkspaceKind::Local,
        created_at: journal.started_at,
        origin: format!("migration:{}", journal.migration_id),
    };
    paths::write_marker(&directory, &marker)?;
    Ok(directory)
}

/// Creates the workspace directory so the copy step has a destination.
///
/// The marker is deliberately not written here: a marker makes the workspace
/// exist for the rest of the app (the registry is rebuilt from markers), and
/// that must only happen when the migration is committed in `activate`.
fn ensure_materialized(ctx: &Ctx, journal: &Journal) -> Result<(), String> {
    let directory = ctx.workspace_dir(&journal.workspace_id)?;
    fs::create_dir_all(&directory)
        .map_err(|e| format!("No se pudo crear el espacio de trabajo: {e}"))?;
    Ok(())
}

fn prepare_inner(ctx: &Ctx) -> Result<Journal, String> {
    let loaded = registry::load(&ctx.documents, &ctx.config)?;
    let workspace_id = registry::next_workspace_id(&ctx.documents, loaded.registry());
    let started_at = now_ms();
    let migration_id = new_migration_id();

    let mut items = Vec::new();
    for entry in paths::scan_notes(&ctx.root())? {
        let source = ctx.root().join(&entry.name);
        if entry.symlink {
            // Never followed: it stays in the root and is reported as pending.
            items.push(Item {
                name: entry.name,
                sha256: String::new(),
                size: 0,
                dest_name: None,
                decision: Decision::Deferred,
                origin: origins::modified(&source).unwrap_or_default(),
                dest: None,
                note: Some("Enlace simbólico: no se migra ni se sigue".to_string()),
            });
            continue;
        }
        let (hash, size, stamp) = hash_stable(&source)?;
        items.push(Item {
            name: entry.name,
            sha256: hash,
            size,
            dest_name: None,
            decision: Decision::Pending,
            origin: stamp,
            dest: None,
            note: None,
        });
    }

    // Capture the old causal projection while the original notes and their
    // identities still live together in the legacy root.
    let archived_names = archive::projection(&ctx.root(), None)?.archived_names;
    let archive_ledger_present = ctx.root().join(".lyra_archive_state.json").is_file();
    let mut journal = Journal {
        schema_version: JOURNAL_SCHEMA,
        migration_id,
        phase: Phase::Preparing,
        workspace_id,
        workspace_name: DEFAULT_WORKSPACE_NAME.to_string(),
        started_at,
        updated_at: started_at,
        items,
        archived_names,
        archive_ledger_present,
        retire: None,
        error: None,
    };
    ensure_materialized(ctx, &journal)?;
    save(ctx, &mut journal)?;
    Ok(journal)
}

/// Creates (or resumes) the migration journal. Idempotent.
#[cfg(test)]
pub fn prepare(ctx: &Ctx, _faults: &Faults) -> Result<Journal, String> {
    let _guard = lock()?;
    if let Some(mut journal) = load(ctx)? {
        if journal.phase == Phase::Retired {
            return Ok(journal);
        }
        ensure_materialized(ctx, &journal)?;
        save(ctx, &mut journal)?;
        return Ok(journal);
    }
    prepare_inner(ctx)
}

fn copy_all_inner(ctx: &Ctx, journal: &mut Journal, faults: &Faults) -> Result<(), String> {
    let directory = ctx.workspace_dir(&journal.workspace_id)?;
    fs::create_dir_all(&directory)
        .map_err(|e| format!("No se pudo crear el espacio de trabajo: {e}"))?;
    for index in 0..journal.items.len() {
        let status = evaluate(ctx, journal, &journal.items[index])?;
        if status != ItemStatus::PendingCopy {
            if status != ItemStatus::Copied {
                note_for(&mut journal.items[index], status);
            }
            continue;
        }
        let name = journal.items[index].name.clone();
        let dest = journal.items[index].dest();
        let source = ctx.root().join(&name);
        let destination = directory.join(&dest);
        if faults.blocks_copy(&name) {
            journal.items[index].note = Some("Fallo de copia inyectado (prueba)".to_string());
            continue;
        }
        if destination.exists() {
            let status = evaluate(ctx, journal, &journal.items[index])?;
            note_for(&mut journal.items[index], status);
            continue;
        }
        let temporary = directory.join(format!(".lyra_copy_{:032x}", rand::random::<u128>()));
        match copy_with_hash(&source, &temporary) {
            Ok((hash, size)) => {
                if hash != journal.items[index].sha256 {
                    let _ = fs::remove_file(&temporary);
                    journal.items[index].note = Some(
                        "El contenido cambió mientras se copiaba; vuelve a intentarlo".to_string(),
                    );
                    continue;
                }
                match place_no_clobber(&temporary, &destination) {
                    Ok(()) => {
                        let metadata = fs::metadata(&destination).map_err(|e| {
                            format!("No se pudo inspeccionar la copia '{}': {e}", dest)
                        })?;
                        journal.items[index].dest = Some(origins::stamp_of(&metadata));
                        journal.items[index].note = None;
                        if size != journal.items[index].size {
                            journal.items[index].size = size;
                        }
                    }
                    Err(error) => {
                        journal.items[index].note = Some(error);
                    }
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                journal.items[index].note = Some(error);
            }
        }
    }
    refresh_phase(ctx, journal)?;
    save(ctx, journal)
}

/// Copies every pending item. Existing destinations are never overwritten.
#[cfg(test)]
pub fn copy_all(ctx: &Ctx, journal: &mut Journal, faults: &Faults) -> Result<(), String> {
    let _guard = lock()?;
    copy_all_inner(ctx, journal, faults)
}

fn refresh_phase(ctx: &Ctx, journal: &mut Journal) -> Result<(), String> {
    if matches!(journal.phase, Phase::Activated | Phase::Retired) {
        return Ok(());
    }
    let gate = gate(ctx, journal)?;
    journal.phase = if gate.open {
        Phase::Prepared
    } else {
        Phase::Copied
    };
    Ok(())
}

fn activate_inner(ctx: &Ctx, journal: &mut Journal) -> Result<(), String> {
    if matches!(journal.phase, Phase::Activated | Phase::Retired) {
        return Ok(());
    }
    let gate = gate(ctx, journal)?;
    if !gate.open {
        return Err("La migración todavía tiene elementos sin resolver".to_string());
    }
    let directory = ctx.workspace_dir(&journal.workspace_id)?;
    let local_archived: Vec<String> = journal.items.iter()
        .filter(|item| item.decision != Decision::Deferred && item.decision != Decision::AdoptDestination)
        .filter(|item| journal.archived_names.contains(&item.name))
        .map(Item::dest)
        .collect();
    if journal.archive_ledger_present {
        archive::initialize_legacy(&directory, &local_archived)?;
    }
    let directory = write_workspace_marker(ctx, journal)?;
    if !directory.is_dir() {
        return Err("El espacio de trabajo no existe".to_string());
    }
    let loaded = registry::load(&ctx.documents, &ctx.config)?;
    let workspace = Workspace {
        id: journal.workspace_id.clone(),
        name: journal.workspace_name.clone(),
        kind: WorkspaceKind::Local,
        created_at: journal.started_at,
        account: None,
        linkage_lost: false,
    };
    let updated = registry::upsert(
        loaded.into_registry(),
        workspace,
        Some(journal.migration_id.clone()),
        now_ms(),
    );
    registry::save(&ctx.config, &updated)?;
    journal.phase = Phase::Activated;
    save(ctx, journal)
}

/// Commits the workspace: marker + registry. Only then does the workspace
/// exist as far as the rest of the app is concerned.
#[cfg(test)]
pub fn activate(ctx: &Ctx, journal: &mut Journal) -> Result<(), String> {
    let _guard = lock()?;
    activate_inner(ctx, journal)
}

fn retire_stamp(journal: &Journal) -> i64 {
    let seconds = journal.started_at / 1000;
    if seconds > 0 {
        seconds
    } else {
        chrono::Utc::now().timestamp()
    }
}

fn retire_all_inner(
    ctx: &Ctx,
    journal: &mut Journal,
    faults: &Faults,
) -> Result<(), String> {
    if journal.phase == Phase::Retired {
        return Ok(());
    }
    if journal.phase != Phase::Activated {
        return Err("La migración no está activada: no se retiran originales".to_string());
    }
    let directory = ctx.workspace_dir(&journal.workspace_id)?;
    let retire_dir = paths::rescatados_dir(&ctx.documents, "migracion", retire_stamp(journal));
    let relative_dir = retire_dir
        .strip_prefix(&ctx.documents)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| retire_dir.to_string_lossy().to_string());
    let mut report = RetireReport {
        completed_at: now_ms(),
        directory: relative_dir,
        ..RetireReport::default()
    };

    for item in journal.items.iter_mut() {
        if item.decision == Decision::Deferred {
            continue;
        }
        let source = ctx.root().join(&item.name);
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            // Already gone: either retired in a previous run or deleted while
            // the app was closed. Nothing to do, nothing to lose.
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            report.conflicts.push(RetireConflict {
                name: item.name.clone(),
                reason: "source_symlink".to_string(),
                detail: "El original es un enlace simbólico; no se mueve ni se sigue".to_string(),
            });
            continue;
        }
        if !origins::unchanged(&item.origin, &metadata) {
            let (hash, _) = origins::hash_file(&source)?;
            if hash != item.sha256 {
                report.conflicts.push(RetireConflict {
                    name: item.name.clone(),
                    reason: "source_changed".to_string(),
                    detail: "La nota original cambió después de la activación; se conserva intacta"
                        .to_string(),
                });
                continue;
            }
            item.origin = origins::stamp_of(&metadata);
        }

        let destination = directory.join(item.dest());
        let destination_metadata = match fs::metadata(&destination) {
            Ok(metadata) => metadata,
            Err(_) => {
                report.conflicts.push(RetireConflict {
                    name: item.name.clone(),
                    reason: "destination_missing".to_string(),
                    detail: "La copia en el espacio de trabajo ya no existe; el original se conserva"
                        .to_string(),
                });
                continue;
            }
        };
        if item.decision != Decision::AdoptDestination && !dest_matches(item, &destination_metadata) {
            let (hash, _) = origins::hash_file(&destination)?;
            if hash != item.sha256 {
                report.conflicts.push(RetireConflict {
                    name: item.name.clone(),
                    reason: "destination_replaced".to_string(),
                    detail: "La copia cambió de contenido; el original se conserva intacto".to_string(),
                });
                continue;
            }
        }
        if faults.blocks_retire(&item.name) {
            report.conflicts.push(RetireConflict {
                name: item.name.clone(),
                reason: "retire_failed".to_string(),
                detail: "No se pudo mover el original (fallo inyectado)".to_string(),
            });
            continue;
        }

        fs::create_dir_all(&retire_dir)
            .map_err(|e| format!("No se pudo crear la carpeta de respaldo: {e}"))?;
        match move_no_clobber(&source, &retire_dir, &item.name) {
            Ok(_) => report.retired.push(RetiredEntry {
                name: item.name.clone(),
                dest_name: item.dest(),
                sha256: item.sha256.clone(),
            }),
            Err(error) => report.conflicts.push(RetireConflict {
                name: item.name.clone(),
                reason: "retire_failed".to_string(),
                detail: format!("No se pudo mover el original: {error}"),
            }),
        }
    }

    if !report.retired.is_empty() || !report.conflicts.is_empty() {
        fs::create_dir_all(&retire_dir)
            .map_err(|e| format!("No se pudo crear la carpeta de respaldo: {e}"))?;
        let manifest = serde_json::json!({
            "schema_version": 1,
            "migration_id": journal.migration_id,
            "retired_at": report.completed_at,
            "retired": report.retired,
            "conflicts": report.conflicts,
        });
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        paths::write_atomic(&retire_dir.join(paths::RETIRED_MANIFEST), &bytes)?;
    }

    journal.retire = Some(report);
    journal.phase = Phase::Retired;
    save(ctx, journal)
}

/// Moves every original to `rescatados/`. Conflicts are recorded and keep the
/// file intact; they never abort the pass.
#[cfg(test)]
pub fn retire_all(ctx: &Ctx, journal: &mut Journal, faults: &Faults) -> Result<(), String> {
    let _guard = lock()?;
    retire_all_inner(ctx, journal, faults)
}

fn advance(ctx: &Ctx, mut journal: Journal, faults: &Faults) -> Result<Journal, String> {
    if matches!(journal.phase, Phase::Preparing | Phase::Copied) {
        copy_all_inner(ctx, &mut journal, faults)?;
    }
    if journal.phase != Phase::Activated && journal.phase != Phase::Retired {
        let gate = gate(ctx, &journal)?;
        if !gate.open {
            refresh_phase(ctx, &mut journal)?;
            save(ctx, &mut journal)?;
            return Ok(journal);
        }
        activate_inner(ctx, &mut journal)?;
    }
    retire_all_inner(ctx, &mut journal, faults)?;
    Ok(journal)
}

/// Runs the whole migration, resuming whatever was already done.
///
/// `Ok(None)` means there is nothing to migrate because a registry with
/// workspaces already exists.
pub fn run(ctx: &Ctx, faults: &Faults) -> Result<Option<Journal>, String> {
    let _guard = lock()?;
    if let Some(journal) = load(ctx)? {
        if journal.phase == Phase::Retired {
            return Ok(Some(journal));
        }
        return advance(ctx, journal, faults).map(Some);
    }
    let loaded = registry::load(&ctx.documents, &ctx.config)?;
    if let Some(registry) = loaded.registry() {
        if !registry.workspaces.is_empty() {
            if loaded.is_rebuilt() {
                registry::save(&ctx.config, registry)?;
            }
            return Ok(None);
        }
    }
    let journal = prepare_inner(ctx)?;
    advance(ctx, journal, faults).map(Some)
}

/// Journal used to import notes that show up in the root once the migration is
/// over, or when the installation already has workspaces. It never re-runs the
/// migration: the phase starts as `Retired`.
pub fn journal_for_imports(ctx: &Ctx) -> Result<Option<Journal>, String> {
    if let Some(journal) = load(ctx)? {
        return Ok(Some(journal));
    }
    let loaded = registry::load(&ctx.documents, &ctx.config)?;
    let Some(registry) = loaded.into_registry() else {
        return Ok(None);
    };
    let Some(workspace) = registry.active() else {
        return Ok(None);
    };
    if workspace.write_policy() != WritePolicy::Editable {
        return Ok(None);
    }
    let now = now_ms();
    Ok(Some(Journal {
        schema_version: JOURNAL_SCHEMA,
        migration_id: new_migration_id(),
        phase: Phase::Retired,
        workspace_id: workspace.id.clone(),
        workspace_name: workspace.name.clone(),
        started_at: now,
        updated_at: now,
        items: Vec::new(),
        archived_names: Vec::new(),
        archive_ledger_present: false,
        retire: None,
        error: None,
    }))
}

/// A user decision about one blocked item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    KeepBoth,
    AdoptDestination,
    Retry,
    Defer,
    Dismiss,
}

/// Applies a decision and copies immediately when possible.
pub fn resolve_item(ctx: &Ctx, name: &str, action: Action, faults: &Faults) -> Result<Journal, String> {
    let _guard = lock()?;
    let mut journal = load(ctx)?.ok_or("No hay ninguna migración en curso")?;
    if journal.phase == Phase::Retired {
        return Err("La migración ya terminó".to_string());
    }
    let index = journal
        .items
        .iter()
        .position(|item| item.name == name)
        .ok_or_else(|| format!("'{name}' no forma parte de la migración"))?;
    let status = evaluate(ctx, &journal, &journal.items[index])?;
    match action {
        Action::Defer => {
            if status == ItemStatus::SourceMissing {
                return Err(
                    "La nota ya no existe en la carpeta principal; solo puedes descartarla"
                        .to_string(),
                );
            }
            journal.items[index].decision = Decision::Deferred;
            journal.items[index].note = Some(status_detail(ItemStatus::Deferred).to_string());
        }
        Action::Dismiss => {
            if status != ItemStatus::SourceMissing {
                return Err(
                    "Solo se puede descartar una entrada cuyo original ya no existe".to_string(),
                );
            }
            journal.items.remove(index);
        }
        Action::AdoptDestination => {
            let destination = ctx
                .workspace_dir(&journal.workspace_id)?
                .join(journal.items[index].dest());
            if !destination.is_file() {
                return Err("La copia en el espacio de trabajo ya no existe".to_string());
            }
            journal.items[index].decision = Decision::AdoptDestination;
            journal.items[index].note = None;
        }
        Action::KeepBoth => {
            refresh_source(ctx, &mut journal.items[index])?;
            let directory = ctx.workspace_dir(&journal.workspace_id)?;
            let dest_name = unique_name(&directory, &journal.items[index].name);
            journal.items[index].dest_name = Some(dest_name);
            journal.items[index].decision = Decision::KeepBoth;
            journal.items[index].dest = None;
            journal.items[index].note = None;
            copy_all_inner(ctx, &mut journal, faults)?;
        }
        Action::Retry => {
            refresh_source(ctx, &mut journal.items[index])?;
            journal.items[index].decision = Decision::Pending;
            journal.items[index].dest = None;
            journal.items[index].note = None;
            copy_all_inner(ctx, &mut journal, faults)?;
        }
    }
    refresh_phase(ctx, &mut journal)?;
    save(ctx, &mut journal)?;
    Ok(journal)
}

fn validate_incoming_note(ctx: &Ctx, name: &str) -> Result<PathBuf, String> {
    if !paths::is_note_name(name) {
        return Err(format!("'{name}' no es una nota válida"));
    }
    crate::gdrive::sync::is_safe_filename(name)
        .then_some(())
        .ok_or_else(|| format!("'{name}' no es un nombre de archivo seguro"))?;
    let source = ctx.root().join(name);
    let metadata = fs::symlink_metadata(&source)
        .map_err(|_| format!("'{name}' ya no existe en la carpeta principal"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("'{name}' es un enlace simbólico y no se importa"));
    }
    if !metadata.is_file() {
        return Err(format!("'{name}' no es un archivo"));
    }
    Ok(source)
}

/// Imports a note that appeared in the root during (or after) the migration.
/// The copy is never overwritten and the original is moved to
/// `rescatados/importados-<stamp>/`, never deleted.
pub fn import_stray(ctx: &Ctx, journal: &mut Journal, name: &str) -> Result<(), String> {
    let _guard = lock()?;
    let source = validate_incoming_note(ctx, name)?;
    let directory = ctx.workspace_dir(&journal.workspace_id)?;
    fs::create_dir_all(&directory)
        .map_err(|e| format!("No se pudo crear el espacio de trabajo: {e}"))?;
    let destination = directory.join(name);
    if destination.exists() {
        return Err(format!(
            "El espacio de trabajo ya tiene una nota llamada '{name}'; resuélvela antes de importar"
        ));
    }
    let temporary = directory.join(format!(".lyra_copy_{:032x}", rand::random::<u128>()));
    let (hash, size) = match copy_with_hash(&source, &temporary) {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    if let Err(error) = place_no_clobber(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let metadata = fs::metadata(&destination)
        .map_err(|e| format!("No se pudo verificar la copia importada: {e}"))?;

    let imported_dir = paths::rescatados_dir(
        &ctx.documents,
        "importados",
        chrono::Utc::now().timestamp(),
    );
    fs::create_dir_all(&imported_dir)
        .map_err(|e| format!("No se pudo crear la carpeta de importados: {e}"))?;
    move_no_clobber(&source, &imported_dir, name)
        .map_err(|e| format!("No se pudo mover el original importado: {e}"))?;

    // The deferred journal entry is gone: the note now lives in the workspace.
    journal.items.retain(|item| !(item.name == name && item.decision == Decision::Deferred));
    let _ = (hash, size, origins::stamp_of(&metadata));
    save(ctx, journal)
}

/// Leaves a stray note in the root on purpose. It stays reported as pending.
pub fn defer_stray(ctx: &Ctx, journal: &mut Journal, name: &str) -> Result<(), String> {
    let _guard = lock()?;
    let source = validate_incoming_note(ctx, name)?;
    if let Some(item) = journal.items.iter_mut().find(|item| item.name == name) {
        item.decision = Decision::Deferred;
        item.note = Some(status_detail(ItemStatus::Deferred).to_string());
    } else {
        let (hash, size, stamp) = hash_stable(&source)?;
        journal.items.push(Item {
            name: name.to_string(),
            sha256: hash,
            size,
            dest_name: None,
            decision: Decision::Deferred,
            origin: stamp,
            dest: None,
            note: Some(status_detail(ItemStatus::Deferred).to_string()),
        });
        journal.items.sort_by(|a, b| a.name.cmp(&b.name));
    }
    save(ctx, journal)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetireAction {
    /// Keep the original in the root; it becomes a pending import.
    KeepAsPending,
    /// Move the original to `rescatados/conflictos-<stamp>/`.
    MoveToRescatados,
}

/// Resolves a retire conflict without deleting anything.
pub fn resolve_retire(
    ctx: &Ctx,
    journal: &mut Journal,
    name: &str,
    action: RetireAction,
) -> Result<(), String> {
    let _guard = lock()?;
    let report = journal
        .retire
        .as_mut()
        .ok_or("La migración todavía no ha retirado originales")?;
    let index = report
        .conflicts
        .iter()
        .position(|conflict| conflict.name == name)
        .ok_or_else(|| format!("'{name}' no tiene ningún conflicto de retiro pendiente"))?;
    match action {
        RetireAction::KeepAsPending => {
            if let Some(item) = journal.items.iter_mut().find(|item| item.name == name) {
                item.decision = Decision::Deferred;
                item.note = Some(status_detail(ItemStatus::Deferred).to_string());
            }
            report.resolved.push(RetireResolution {
                name: name.to_string(),
                action: "keep_as_pending".to_string(),
                at: now_ms(),
            });
        }
        RetireAction::MoveToRescatados => {
            let source = ctx.root().join(name);
            let directory = paths::rescatados_dir(
                &ctx.documents,
                "conflictos",
                chrono::Utc::now().timestamp(),
            );
            fs::create_dir_all(&directory)
                .map_err(|e| format!("No se pudo crear la carpeta de conflictos: {e}"))?;
            move_no_clobber(&source, &directory, name)
                .map_err(|e| format!("No se pudo mover el original a rescatados: {e}"))?;
            journal.items.retain(|item| item.name != name);
            report.resolved.push(RetireResolution {
                name: name.to_string(),
                action: "move_to_rescatados".to_string(),
                at: now_ms(),
            });
        }
    }
    report.conflicts.remove(index);
    save(ctx, journal)
}

#[cfg(test)]
mod tests;
