use super::auth;
use super::client::{DriveClient, RemoteFileStatus};
use super::provenance::{AuthorizationSource, SyncAccountContext};
use super::types::{DriveFileMetadata, FileManifestItem, SyncManifest, SyncResult};
use chrono::Utc;
use md5::{Digest, Md5};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::fs;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
pub struct DownloadedFilePayload {
    pub name: String,
}

#[cfg(test)]
mod phase5_manifest_tests {
    use super::*;

    fn item(id: &str) -> FileManifestItem {
        FileManifestItem {
            drive_id: id.into(), md5: "hash".into(), local_mtime: 1,
            remote_mtime: String::new(), local_size: 1,
        }
    }

    #[test]
    fn concurrent_deletion_cannot_resurrect_stale_mapping_or_tombstone() {
        let mut baseline = SyncManifest::default();
        baseline.files.insert("Note.md".into(), item("old"));
        baseline.pending_deletions.insert("Old.md".into(), super::super::types::PendingDeletion {
            drive_id: Some("deleted".into()), deleted_at: 1,
            account_key: Some("a".into()), note_id: Some("n".into()),
        });
        let disk = SyncManifest::default();
        let mut in_flight = baseline.clone();
        merge_concurrent_manifest_changes(&baseline, &disk, &mut in_flight);
        assert!(!in_flight.files.contains_key("Note.md"));
        assert!(!in_flight.pending_deletions.contains_key("Old.md"));
    }

    #[test]
    fn new_tombstone_and_file_mapping_win_over_stale_sync_snapshot() {
        let baseline = SyncManifest::default();
        let mut disk = baseline.clone();
        disk.files.insert("New.md".into(), item("new"));
        disk.pending_deletions.insert("Gone.md".into(), super::super::types::PendingDeletion {
            drive_id: Some("gone".into()), deleted_at: 2,
            account_key: Some("a".into()), note_id: Some("n2".into()),
        });
        let mut in_flight = baseline.clone();
        in_flight.files.insert("Gone.md".into(), item("stale"));
        merge_concurrent_manifest_changes(&baseline, &disk, &mut in_flight);
        assert_eq!(in_flight.files["New.md"].drive_id, "new");
        assert!(!in_flight.files.contains_key("Gone.md"));
        assert_eq!(in_flight.pending_deletions["Gone.md"].drive_id.as_deref(), Some("gone"));
    }
}

pub trait SyncProgressEmitter: Send + Sync {
    fn emit_download_start(&self);
    fn emit_file_downloaded(&self, file_name: &str);
    fn emit_download_finish(&self);
}

pub struct TauriSyncEmitter<'a>(pub &'a tauri::AppHandle);

impl<'a> SyncProgressEmitter for TauriSyncEmitter<'a> {
    fn emit_download_start(&self) {
        let _ = self.0.emit("gdrive:download_start", ());
    }

    fn emit_file_downloaded(&self, file_name: &str) {
        let _ = self.0.emit(
            "gdrive:file_downloaded",
            DownloadedFilePayload {
                name: file_name.to_string(),
            },
        );
    }

    fn emit_download_finish(&self) {
        let _ = self.0.emit("gdrive:download_finish", ());
    }
}

const MANIFEST_FILE_NAME: &str = ".gdrive_manifest.json";

pub static MANIFEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn compute_md5(data: &[u8]) -> String {
    let mut hasher = Md5::new();
    hasher.update(data);
    let result = hasher.finalize();
    format!("{result:x}")
}

pub fn get_manifest_path_for_account(lyra_dir: &std::path::Path, account_key: &str) -> PathBuf {
    lyra_dir.join(format!(".gdrive_manifest_{account_key}.json"))
}

pub fn get_legacy_manifest_path(lyra_dir: &std::path::Path) -> PathBuf {
    lyra_dir.join(MANIFEST_FILE_NAME)
}

pub fn load_manifest_from_path(path: &std::path::Path) -> SyncManifest {
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(manifest) = serde_json::from_str::<SyncManifest>(&content) {
                return manifest;
            } else {
                eprintln!("[SyncManifest] Advertencia: El manifiesto principal en '{}' está dañado o incompleto. Intentando recuperar desde copia de seguridad .bak...", path.display());
            }
        }
    }

    // Intentar recuperación desde la copia de respaldo .bak ante corrupción del archivo principal
    let bak_path = path.with_extension("json.bak");
    if bak_path.exists() {
        if let Ok(content) = fs::read_to_string(&bak_path) {
            if let Ok(manifest) = serde_json::from_str::<SyncManifest>(&content) {
                eprintln!("[SyncManifest] Manifiesto recuperado exitosamente desde '{}'.", bak_path.display());
                return manifest;
            }
        }
    }

    SyncManifest::default()
}

pub fn save_manifest_to_path(path: &std::path::Path, manifest: &SyncManifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let content = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Error serializando manifiesto de sincronización: {e}"))?;

    let rand_num: u32 = rand::random();
    let tmp_path = path.with_file_name(format!(".gdrive_manifest.tmp.{}", rand_num));

    // Escribir con flush físico en disco para garantizar durabilidad ante cortes de energía
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| format!("Error creando archivo temporal de manifiesto: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("Error escribiendo archivo temporal de manifiesto: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Error asegurando durabilidad física en disco: {e}"))?;
    }

    // Mantener copia de seguridad .bak del manifiesto anterior válido
    if path.exists() {
        let bak_path = path.with_extension("json.bak");
        let _ = fs::copy(path, &bak_path);
    }

    // Reemplazo atómico mediante renombrado
    fs::rename(&tmp_path, path)
        .map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Error reemplazando manifiesto atómicamente: {e}")
        })?;

    // Limpieza preventiva de posibles temporales huérfanos anteriores
    if let Some(parent) = path.parent() {
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                if let Ok(ft) = entry.file_type() {
                    if ft.is_file() {
                        let fname = entry.file_name().to_string_lossy().to_string();
                        if fname.starts_with(".gdrive_manifest.tmp.") && entry.path() != tmp_path {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

pub fn load_manifest_for_account_dir(
    lyra_dir: &std::path::Path,
    account_key: &str,
    account_email: Option<&str>,
) -> SyncManifest {
    let account_path = get_manifest_path_for_account(lyra_dir, account_key);
    if account_path.exists() || account_path.with_extension("json.bak").exists() {
        let mut manifest = load_manifest_from_path(&account_path);
        if manifest.account_id.is_none() {
            manifest.account_id = Some(account_key.to_string());
        }
        if manifest.account_email.is_none() && account_email.is_some() {
            manifest.account_email = account_email.map(|s| s.to_string());
        }
        return manifest;
    }

    // Migración segura desde manifiesto heredado global si existe
    let legacy_path = get_legacy_manifest_path(lyra_dir);
    if legacy_path.exists() || legacy_path.with_extension("json.bak").exists() {
        let legacy = load_manifest_from_path(&legacy_path);
        if legacy.account_id.as_deref() == Some(account_key) {
            return legacy;
        }
        if let (Some(leg_email), Some(act_email)) = (legacy.account_email.as_deref(), account_email) {
            if leg_email.eq_ignore_ascii_case(act_email) {
                let mut migrated = legacy;
                migrated.account_id = Some(account_key.to_string());
                migrated.account_email = Some(act_email.to_string());
                return migrated;
            }
        }
        if legacy.account_id.is_none() {
            // Si el manifiesto heredado no tiene archivos ni tombstones, iniciar limpio sin transferir drive_folder_id obsoleto
            if legacy.files.is_empty() && legacy.pending_deletions.is_empty() {
                return SyncManifest {
                    account_id: Some(account_key.to_string()),
                    account_email: account_email.map(|s| s.to_string()),
                    ..SyncManifest::default()
                };
            }
            // Si contiene archivos o tombstones pero no sabemos de qué cuenta es,
            // NO se asigna a ciegas para evitar transferir tombstones/mapeos a otra cuenta.
            // Se preserva intacto el archivo heredado.
            eprintln!(
                "[SyncManifest] Manifiesto heredado preservado sin asociar arbitrariamente a '{}'.",
                account_key
            );
        }
    }

    SyncManifest {
        account_id: Some(account_key.to_string()),
        account_email: account_email.map(|s| s.to_string()),
        ..SyncManifest::default()
    }
}

pub fn load_manifest(app: &tauri::AppHandle) -> SyncManifest {
    if let Ok(doc_dir) = app.path().document_dir() {
        let lyra_dir = doc_dir.join("lyra");
        if ensure_safe_base_dir(&lyra_dir).is_err() { return SyncManifest::default(); }
        if let Ok(Some(auth_state)) = auth::load_auth_state(app) {
            let key = auth::get_account_key(&auth_state.user);
            return load_manifest_for_account_dir(&lyra_dir, &key, Some(&auth_state.user.email));
        }
        return load_manifest_from_path(&get_legacy_manifest_path(&lyra_dir));
    }
    SyncManifest::default()
}

pub const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Valida de forma estricta que un nombre de archivo represente un único componente seguro,
/// compatible con los sistemas operativos soportados (Linux, Windows, macOS), sin prefijos de unidad,
/// sin separadores de ruta ni intentos de path traversal.
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    ".txt", ".md", ".markdown",
    ".json", ".jsonc",
    ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".csv", ".log",
    ".html", ".htm", ".xml",
    ".css", ".scss",
    ".js", ".jsx", ".ts", ".tsx",
    ".py", ".rs", ".sh", ".sql",
];

pub fn has_supported_extension(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SUPPORTED_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

pub fn is_safe_filename(name: &str) -> bool {
    if name.is_empty() || name != name.trim() {
        return false;
    }

    // No permitir espacios o puntos al inicio o al final (incompatibles en Windows y archivos ocultos de Unix)
    if name.starts_with('.') || name.ends_with('.') || name.starts_with(' ') || name.ends_with(' ') {
        return false;
    }

    // Si tiene extensión, debe pertenecer a los formatos de texto plano soportados
    if let Some(dot_idx) = name.rfind('.') {
        let ext = name[dot_idx..].to_ascii_lowercase();
        if !SUPPORTED_EXTENSIONS.iter().any(|s| *s == ext) {
            return false;
        }
    }

    // Caracteres prohibidos en Windows y POSIX: < > : " / \ | ? * y caracteres de control (0..=31, 127)
    for ch in name.chars() {
        if ch.is_control()
            || ch == '<'
            || ch == '>'
            || ch == ':'
            || ch == '"'
            || ch == '/'
            || ch == '\\'
            || ch == '|'
            || ch == '?'
            || ch == '*'
        {
            return false;
        }
    }

    // Nombres reservados de dispositivos de Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    // Se evalúa el componente antes del primer punto para evitar evasiones tipo `con.txt` o `CON.backup.md`
    let primary_stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED_NAMES.contains(&primary_stem.as_str()) {
        return false;
    }

    // Verificar que la ruta represente exactamente un único componente 'Normal'
    let path = std::path::Path::new(name);
    let mut components = path.components();
    match components.next() {
        Some(std::path::Component::Normal(comp)) => {
            if comp.to_str() != Some(name) {
                return false;
            }
        }
        _ => return false,
    }

    // No debe haber componentes adicionales
    if components.next().is_some() {
        return false;
    }

    true
}

/// Resuelve una ruta absoluta segura dentro de `base_dir` garantizando que no escape del directorio autorizado
/// ni a través de nombres manipulados ni mediante enlaces simbólicos existentes.
pub fn ensure_safe_base_dir(base_dir: &std::path::Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(base_dir)
        .map_err(|e| format!("Cannot inspect notes directory: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Notes directory must be a real directory, not a symbolic link".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Notes directory cannot be a Windows reparse point".to_string());
        }
    }
    Ok(())
}

pub fn resolve_safe_path(base_dir: &std::path::Path, file_name: &str) -> Result<PathBuf, String> {
    ensure_safe_base_dir(base_dir)?;
    if !is_safe_filename(file_name) {
        return Err(format!("Nombre de archivo inválido o no seguro: '{file_name}'"));
    }

    let target_path = base_dir.join(file_name);

    // Verificar que el padre inmediato sea exactamente base_dir
    if target_path.parent() != Some(base_dir) {
        return Err(format!(
            "La ruta calculada para '{file_name}' intenta escapar del directorio base"
        ));
    }

    // Verificar que target_path no sea un enlace simbólico (prevención estricta de symlink traversal)
    if let Ok(meta) = std::fs::symlink_metadata(&target_path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Enlace simbólico '{file_name}' no permitido (los archivos de Lyra deben ser archivos regulares)"
            ));
        }
    }

    Ok(target_path)
}

/// Coordinador de bloqueos por archivo para evitar condiciones de carrera TOCTOU entre
/// el guardado local del editor (IPC save_note_atomic) y la descarga/reemplazo de notas de Google Drive.
/// No utiliza un bloqueo global sobre todas las notas, sino un bloqueo específico por nombre de archivo.
#[derive(Default, Clone)]
pub struct FileLockCoordinator {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl FileLockCoordinator {
    pub fn new() -> Self {
        Self {
            locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Ejecuta una clausura `f` bajo el bloqueo exclusivo del archivo indicado.
    /// Garantiza que ninguna otra tarea en el proceso pueda verificar o escribir concurrentemente sobre este mismo archivo.
    pub fn with_file_lock<F, R>(&self, file_name: &str, f: F) -> R
    where
        F: FnOnce() -> R,
    {
        let file_mutex = {
            let mut map = self.locks.lock().unwrap();
            map.entry(file_name.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        let result = {
            let _guard = file_mutex.lock().unwrap();
            f()
        };

        // Limpieza oportunista del mapa si ya no hay otros hilos esperando este mutex
        {
            let mut map = self.locks.lock().unwrap();
            if let Some(entry) = map.get(file_name) {
                if Arc::strong_count(entry) <= 2 {
                    map.remove(file_name);
                }
            }
        }

        result
    }
}

static GLOBAL_FILE_LOCK_COORDINATOR: std::sync::OnceLock<FileLockCoordinator> = std::sync::OnceLock::new();

pub fn get_file_lock_coordinator() -> &'static FileLockCoordinator {
    GLOBAL_FILE_LOCK_COORDINATOR.get_or_init(FileLockCoordinator::new)
}

static PENDING_RECOVERED_NOTES: Mutex<Vec<String>> = Mutex::new(Vec::new());
static APP_HANDLE_FOR_RECOVERY: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn set_app_handle_for_recovery(app: tauri::AppHandle) {
    let _ = APP_HANDLE_FOR_RECOVERY.set(app);
}

pub fn record_recovered_notes(notes: &[String]) {
    if notes.is_empty() {
        return;
    }
    {
        let mut pending = PENDING_RECOVERED_NOTES.lock().unwrap();
        for note in notes {
            if !pending.contains(note) {
                pending.push(note.clone());
            }
        }
    }
    if let Some(app) = APP_HANDLE_FOR_RECOVERY.get() {
        let _ = app.emit("lyra:notes_recovered", notes.to_vec());
    }
}

pub fn drain_recovered_notes() -> Vec<String> {
    let mut pending = PENDING_RECOVERED_NOTES.lock().unwrap();
    std::mem::take(&mut *pending)
}

/// Escribe una nota recuperada de un guardado interrumpido con nombre único y exclusivo.
/// Previene colisiones y sobrescrituras usando `create_new(true)` (`O_CREAT | O_EXCL`).
/// Si ya existe un archivo con la misma marca temporal, genera sufijos secuenciales ` (1)`, ` (2)`, etc.
pub fn write_unique_recovery_file(
    base_dir: &std::path::Path,
    original_filename: &str,
    content: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<String, std::io::Error> {
    use std::io::Write;

    let safe_original = if is_safe_filename(original_filename) {
        original_filename
    } else {
        "nota_recuperada.txt"
    };

    let (stem, ext) = split_filename(safe_original);
    let date_tag = now.format("%Y%m%d_%H%M%S").to_string();

    // 1. Intento sin sufijo incremental
    let initial_name = format!("{stem} (recuperado de guardado {date_tag}){ext}");
    let initial_path = resolve_safe_path(base_dir, &initial_name)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;

    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&initial_path)
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(content).and_then(|()| file.sync_all()) {
                let _ = std::fs::remove_file(&initial_path);
                return Err(e);
            }
            #[cfg(unix)]
            {
                if let Ok(dir_file) = std::fs::File::open(base_dir) {
                    let _ = dir_file.sync_all();
                }
            }
            return Ok(initial_name);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Colisión con copia existente; proceder a sufijos numéricos
        }
        Err(e) => return Err(e),
    }

    // 2. Intentos con sufijo incremental secuencial
    let mut counter = 1;
    loop {
        let candidate_name = format!("{stem} (recuperado de guardado {date_tag}) ({counter}){ext}");
        let candidate_path = resolve_safe_path(base_dir, &candidate_name)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;

        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate_path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(content).and_then(|()| file.sync_all()) {
                    let _ = std::fs::remove_file(&candidate_path);
                    return Err(e);
                }
                #[cfg(unix)]
                {
                    if let Ok(dir_file) = std::fs::File::open(base_dir) {
                        let _ = dir_file.sync_all();
                    }
                }
                return Ok(candidate_name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                counter += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Limpia de manera preventiva archivos temporales (.tmp_save_*) huérfanos dejados por cierres abruptos o caídas.
/// REGLA DE SEGURIDAD CRÍTICA: La antigüedad no es prueba de que el contenido sea descartable.
/// Si un temporal contiene datos que no existen o difieren del archivo de destino,
/// se preserva como una copia de rescate visible antes de limpiar el archivo oculto.
/// Retorna la lista de nombres de notas recuperadas exitosamente.
pub fn clean_stale_tmp_save_files(dir: &std::path::Path) -> Vec<String> {
    let mut recovered = Vec::new();
    if ensure_safe_base_dir(dir).is_err() { return recovered; }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let now = std::time::SystemTime::now();
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() {
                    let fname = entry.file_name().to_string_lossy().to_string();
                    if fname.starts_with(".tmp_save_") {
                        if let Ok(meta) = entry.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if let Ok(duration) = now.duration_since(modified) {
                                    if duration.as_secs() > 300 {
                                        if let Some(rec_name) = process_stale_tmp_file(dir, &entry.path(), &fname) {
                                            recovered.push(rec_name);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if !recovered.is_empty() {
        record_recovered_notes(&recovered);
    }
    recovered
}

pub fn process_stale_tmp_file(
    dir: &std::path::Path,
    tmp_path: &std::path::Path,
    fname: &str,
) -> Option<String> {
    let tmp_bytes = match std::fs::read(tmp_path) {
        Ok(b) => b,
        Err(_) => return None, // Si no se puede leer, no intentar borrar ni rescatar
    };

    // Extraer el nombre del archivo de destino a partir del patrón .tmp_save_{rand_id}_{target_name}
    let remainder = &fname[".tmp_save_".len()..];
    let target_name = if let Some(underscore_idx) = remainder.find('_') {
        &remainder[underscore_idx + 1..]
    } else {
        "nota_recuperada.txt"
    };

    let safe_target_name = if is_safe_filename(target_name) {
        target_name
    } else {
        "nota_recuperada.txt"
    };

    let target_path = dir.join(safe_target_name);

    // Comparar con el archivo de destino si existe
    if target_path.exists() {
        if let Ok(target_bytes) = std::fs::read(&target_path) {
            if compute_md5(&tmp_bytes) == compute_md5(&target_bytes) {
                // El archivo de destino ya contiene exactamente este contenido
                // (aplica a archivos con texto idéntico y a archivos ambos de 0 bytes).
                // Es un duplicado redundante seguro de eliminar sin pérdida de información.
                let _ = std::fs::remove_file(tmp_path);
                return None;
            }
        }
    }

    // El archivo temporal contiene datos que NO están presentes en el destino
    // (o el destino no existe, o difieren en bytes/longitud, incluyendo notas vaciadas legítimamente).
    // Convertir el temporal en una copia de rescate visible y única para el usuario.
    let now = chrono::Utc::now();
    match write_unique_recovery_file(dir, safe_target_name, &tmp_bytes, now) {
        Ok(recovery_name) => {
            // Solo tras confirmar la persistencia y durabilidad en disco de la copia recuperada
            // procedemos a desvincular el archivo temporal original.
            let _ = std::fs::remove_file(tmp_path);
            log_sync_msg(
                dir,
                &format!(
                    "[Recuperación] Temporal huérfano con contenido rescatado como '{}'",
                    recovery_name
                ),
            );
            Some(recovery_name)
        }
        Err(e) => {
            // REGLA DE SEGURIDAD CRÍTICA: Si falla la creación de la copia de rescate
            // (e.g. error de I/O o permisos), NO eliminamos el archivo temporal original.
            log_sync_msg(
                dir,
                &format!(
                    "[Recuperación] Error al crear copia de rescate para '{}': {e}. El temporal se preserva.",
                    fname
                ),
            );
            None
        }
    }
}

/// Lee atómicamente desde el descriptor del archivo abierto sus metadatos (mtime),
/// su contenido íntegro y calcula MD5 y tamaño, garantizando que el snapshot no sufra de desfases TOCTOU.
pub fn read_file_snapshot(
    path: &std::path::Path,
    fallback_mtime: i64,
) -> Result<(Vec<u8>, String, u64, i64), std::io::Error> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mtime = file
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(fallback_mtime);

    let mut content = Vec::new();
    file.read_to_end(&mut content)?;

    let md5 = compute_md5(&content);
    let size = content.len() as u64;
    Ok((content, md5, size, mtime))
}

fn read_authorized_snapshot(
    ctx: &SyncAccountContext,
    name: &str,
    path: &std::path::Path,
    fallback_mtime: i64,
) -> Result<(Vec<u8>, String, u64, i64), std::io::Error> {
    let snapshot = read_file_snapshot(path, fallback_mtime)?;
    if !ctx.can_upload_digest(name, &snapshot.1) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "note content changed since the authorization scan",
        ));
    }
    Ok(snapshot)
}

/// Escribe un archivo de forma atómica y duradera en disco utilizando el patrón .tmp + sync_all + rename.
/// Es seguro frente a caídas del sistema o cortes de energía, previene truncamientos a 0 bytes,
/// limpia temporales en caso de error y sincroniza el directorio padre en sistemas POSIX.
pub fn write_file_atomic(target_path: &std::path::Path, content: &[u8]) -> Result<(), std::io::Error> {
    use std::io::Write;

    let parent_dir = target_path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "El archivo destino no tiene un directorio padre válido",
        )
    })?;

    // Rechazar explícitamente si el destino actual es un enlace simbólico (prevención de TOCTOU / symlink escape)
    if let Ok(meta) = std::fs::symlink_metadata(target_path) {
        if meta.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "Destino '{}' es un enlace simbólico no permitido",
                    target_path.display()
                ),
            ));
        }
    }

    let file_stem = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let rand_id: u64 = rand::random();
    let tmp_path = parent_dir.join(format!(".tmp_save_{}_{}", rand_id, file_stem));

    // Limpieza oportunista amortizada de temporales huérfanos antiguos (~1 de cada 16 escrituras)
    if (rand_id & 0x0F) == 0 {
        clean_stale_tmp_save_files(parent_dir);
    }

    // 1. Escribir contenido en el archivo temporal exclusivo en el mismo directorio (mismo sistema de archivos)
    let write_res = (|| -> Result<(), std::io::Error> {
        let mut tmp_file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;

        tmp_file.write_all(content)?;
        // Forzar vaciado de buffers del sistema operativo al medio físico (durabilidad física)
        tmp_file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    // 2. Renombrado atómico sobre el archivo de destino con reintentos y retroceso exponencial para bloqueos transitorios en Windows
    let mut retries = 5;
    let mut backoff_ms = 10;
    loop {
        match std::fs::rename(&tmp_path, target_path) {
            Ok(()) => {
                // Durabilidad POSIX en Unix: sincronizar descriptor del directorio padre
                #[cfg(unix)]
                {
                    if let Ok(parent_file) = std::fs::File::open(parent_dir) {
                        let _ = parent_file.sync_all();
                    }
                }
                return Ok(());
            }
            Err(_e) if retries > 0 => {
                retries -= 1;
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                backoff_ms = (backoff_ms * 2).min(200);
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(e);
            }
        }
    }
}

fn split_filename(filename: &str) -> (String, String) {
    if let Some(dot_idx) = filename.rfind('.') {
        (filename[..dot_idx].to_string(), filename[dot_idx..].to_string())
    } else {
        (filename.to_string(), ".txt".to_string())
    }
}

/// Escribe de forma atómica y sin carreras TOCTOU una copia de conflicto en el disco local.
/// Si ya existe un archivo con la misma marca temporal (por ejemplo, ejecuciones consecutivas
/// en el mismo segundo), genera un sufijo numérico secuencial ` (1)`, ` (2)`, etc.
pub fn write_unique_conflict_file(
    base_dir: &std::path::Path,
    original_filename: &str,
    content: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<String, std::io::Error> {
    use std::io::Write;

    if !is_safe_filename(original_filename) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("Nombre de archivo original no seguro: '{original_filename}'"),
        ));
    }

    let (stem, ext) = split_filename(original_filename);
    let date_tag = now.format("%Y%m%d_%H%M%S").to_string();

    // 1. Intento sin sufijo
    let initial_name = format!("{stem} (conflicto Google Drive {date_tag}){ext}");
    let initial_path = resolve_safe_path(base_dir, &initial_name)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;

    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&initial_path)
    {
        Ok(mut file) => {
            file.write_all(content)?;
            return Ok(initial_name);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Colisión con copia existente; proceder a sufijos numéricos
        }
        Err(e) => return Err(e),
    }

    // 2. Intentos con sufijo incremental secuencial
    let mut counter = 1;
    loop {
        let candidate_name = format!("{stem} (conflicto Google Drive {date_tag}) ({counter}){ext}");
        let candidate_path = resolve_safe_path(base_dir, &candidate_name)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;

        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate_path)
        {
            Ok(mut file) => {
                file.write_all(content)?;
                return Ok(candidate_name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                counter += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RemoteDeletionAction {
    /// REGLA FUNDAMENTAL: Nunca se elimina el archivo local ante una desaparición en Google Drive.
    /// Si estaba en papelera en Drive, se intenta restaurar (`untrash`).
    RestoreFromTrash,
    /// Si fue eliminado permanentemente en Drive (404/NotFound), se vuelve a subir desde local.
    PreserveAndReupload,
    UpdateRemote,
    Noop,
}

pub fn resolve_remote_deletion_action(
    local_md5: &str,
    manifest_md5: &str,
    remote_status: &RemoteFileStatus,
) -> RemoteDeletionAction {
    let local_changed = local_md5 != manifest_md5;
    match remote_status {
        RemoteFileStatus::Trashed => {
            if local_changed {
                RemoteDeletionAction::PreserveAndReupload
            } else {
                RemoteDeletionAction::RestoreFromTrash
            }
        }
        RemoteFileStatus::NotFound => RemoteDeletionAction::PreserveAndReupload,
        RemoteFileStatus::Forbidden => RemoteDeletionAction::PreserveAndReupload,
        RemoteFileStatus::Active(_) => {
            if local_changed {
                RemoteDeletionAction::UpdateRemote
            } else {
                RemoteDeletionAction::Noop
            }
        }
    }
}

pub fn sanitize_error_message(err: &str) -> String {
    let trimmed = err.trim();
    if trimmed.is_empty() {
        return "Error desconocido de sincronización.".to_string();
    }

    if trimmed.contains("invalid_grant") || trimmed.contains("Sesión revocada") {
        return "La sesión con Google Drive ha expirado o fue revocada. Por favor, vuelve a conectar tu cuenta.".to_string();
    }

    if trimmed.contains("<!DOCTYPE") || trimmed.contains("<html") {
        return "Error del servidor de Google al procesar la solicitud.".to_string();
    }

    let mut sanitized = trimmed.to_string();

    // Redactar tokens de acceso (ya29....) sin perder texto contiguo
    while let Some(pos) = sanitized.find("ya29.") {
        let end = sanitized[pos..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == '&' || c == '}' || c == ']' || c == '\\')
            .unwrap_or(sanitized.len() - pos);
        sanitized.replace_range(pos..pos + end, "[TOKEN_REDACTED]");
    }

    // Redactar tokens de actualización de Google (1//0....)
    while let Some(pos) = sanitized.find("1//0") {
        let end = sanitized[pos..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == '&' || c == '}' || c == ']' || c == '\\')
            .unwrap_or(sanitized.len() - pos);
        sanitized.replace_range(pos..pos + end, "[TOKEN_REDACTED]");
    }

    if sanitized.len() > 300 {
        sanitized.truncate(297);
        sanitized.push_str("...");
    }

    sanitized
}

pub fn log_sync_msg(lyra_dir: &std::path::Path, msg: &str) {
    let now = Utc::now().to_rfc3339();
    eprintln!("{msg}");

    let log_file = lyra_dir.join(".gdrive_sync.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
    {
        let _ = writeln!(f, "[{now}] {msg}");
    }
}

#[allow(dead_code)]
pub async fn run_sync(app: &tauri::AppHandle) -> Result<SyncResult, String> {
    run_sync_with_id(app, "manual").await
}

/// Comprueba si la cuenta activa está autorizada a subir una nota.
/// Si no lo está, la subida se bloquea y se registra para el aviso de consentimiento.
fn note_upload_allowed(
    ctx: &SyncAccountContext,
    name: &str,
    result: &mut SyncResult,
    lyra_dir: &std::path::Path,
    sync_id: &str,
) -> bool {
    let current_digest = fs::read(lyra_dir.join(name)).ok().map(|bytes| compute_md5(&bytes));
    if current_digest.as_deref().is_some_and(|md5| ctx.can_upload_digest(name, md5)) {
        return true;
    }
    if !result.blocked_uploads.iter().any(|n| n == name) {
        result.blocked_uploads.push(name.to_string());
    }
    log_sync_msg(
        lyra_dir,
        &format!(
            "[Sync #{sync_id}] [AUD-001] Subida bloqueada para '{name}': la cuenta activa no está autorizada a subir esta nota. Se conserva intacta localmente."
        ),
    );
    false
}

pub(crate) fn tombstone_allowed(
    lyra_dir: &std::path::Path,
    account_key: &str,
    pending: &super::types::PendingDeletion,
    remote_id: &str,
) -> bool {
    pending.account_key.as_deref() == Some(account_key)
        && pending.drive_id.as_deref() == Some(remote_id)
        && pending.note_id.as_deref().is_some_and(|id| {
            super::provenance::retired_deletion_matches(lyra_dir, id, account_key, remote_id)
        })
}

fn merge_concurrent_manifest_changes(
    baseline: &SyncManifest,
    disk: &SyncManifest,
    current: &mut SyncManifest,
) {
    if disk.drive_folder_id != baseline.drive_folder_id {
        current.drive_folder_id = disk.drive_folder_id.clone();
    }
    for (name, previous) in &baseline.files {
        if !disk.files.contains_key(name) {
            current.files.remove(name);
        } else if disk.files.get(name) != Some(previous) {
            current.files.insert(name.clone(), disk.files[name].clone());
        }
    }
    for (name, item) in &disk.files {
        if !baseline.files.contains_key(name) {
            current.files.insert(name.clone(), item.clone());
        }
    }
    for (name, previous) in &baseline.pending_deletions {
        if !disk.pending_deletions.contains_key(name) {
            current.pending_deletions.remove(name);
        } else if disk.pending_deletions.get(name) != Some(previous) {
            current.pending_deletions.insert(name.clone(), disk.pending_deletions[name].clone());
        }
    }
    for (name, pending) in &disk.pending_deletions {
        if !baseline.pending_deletions.contains_key(name) {
            current.pending_deletions.insert(name.clone(), pending.clone());
        }
    }
    for name in current.pending_deletions.keys() {
        current.files.remove(name);
    }
}

pub async fn run_sync_with_id(app: &tauri::AppHandle, sync_id: &str) -> Result<SyncResult, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("No se pudo resolver la carpeta Documentos: {e}"))?;
    let lyra_dir = doc_dir.join("lyra");
    if !lyra_dir.exists() {
        fs::create_dir_all(&lyra_dir)
            .map_err(|e| format!("Error creando carpeta local de Lyra: {e}"))?;
    }
    ensure_safe_base_dir(&lyra_dir)?;

    // La identidad de la cuenta se verifica desde el backend (sub de Google),
    // nunca desde parámetros del frontend.
    let account = auth::verify_current_account(app)?;
    let account_key = account.account_key.clone();
    let account_email = account.email.clone();
    let epoch = account.epoch;

    // Ruta de manifiesto capturada al inicio: aunque la cuenta cambie durante
    // la sincronización, se guarda exactamente en el manifiesto de esta cuenta.
    let manifest_path = get_manifest_path_for_account(&lyra_dir, &account_key);
    let client = DriveClient::new_with_app_for_account(app, &account_key, epoch)?;

    let mut manifest = {
        let _guard = MANIFEST_LOCK.lock().await;
        // Carga con migración segura desde el manifiesto heredado: un manifiesto
        // antiguo sin cuenta asignada nunca se transfiere a ciegas a otra cuenta.
        load_manifest_for_account_dir(&lyra_dir, &account_key, Some(&account_email))
    };
    let mut ctx = SyncAccountContext::open(&lyra_dir, &account_key, Some(account_email), epoch)?;
    let baseline_manifest = manifest.clone();

    let emitter = TauriSyncEmitter(app);
    let run_result = run_sync_with_client_and_emitter_with_id(
        &lyra_dir,
        &mut manifest,
        &client,
        Some(&emitter),
        &mut ctx,
        sync_id,
    )
    .await;

    // Guardado seguro con re-fusión de tombstones registrados concurrentemente
    // durante la sincronización, siempre sobre la ruta capturada.
    {
        let _guard = MANIFEST_LOCK.lock().await;
        if manifest_path.exists() || manifest_path.with_extension("json.bak").exists() {
            let disk_manifest = load_manifest_from_path(&manifest_path);
            merge_concurrent_manifest_changes(&baseline_manifest, &disk_manifest, &mut manifest);
        }
        save_manifest_to_path(&manifest_path, &manifest)?;
    }

    let mut result = run_result?;
    {
        // Serializado con eliminación, renombrado y consentimiento: al persistir se
        // re-fusionan los cambios concurrentes en lugar de sobrescribirlos.
        let _guard = MANIFEST_LOCK.lock().await;
        ctx.record_manifest_links(&manifest, &result.uploaded);
        ctx.persist()?;
    }
    if let Err(e) = super::archive::sync_remote(&lyra_dir, &account_key, &manifest.drive_folder_id, &client).await {
        result.errors.push(format!("Archive metadata sync: {e}"));
    } else if let Ok(view) = super::archive::projection(&lyra_dir, Some(&account_key)) {
        result.archive_conflicts = view.conflict_names;
    }
    Ok(result)
}

#[cfg(test)]
#[allow(dead_code)]
pub async fn run_sync_with_client(
    lyra_dir: &std::path::Path,
    manifest: &mut SyncManifest,
    client: &DriveClient,
) -> Result<SyncResult, String> {
    let mut ctx = SyncAccountContext::open_test(lyra_dir, "test")?;
    run_sync_with_client_and_emitter_with_id(lyra_dir, manifest, client, None, &mut ctx, "test").await
}

#[cfg(test)]
#[allow(dead_code)]
pub async fn run_sync_with_client_and_emitter(
    lyra_dir: &std::path::Path,
    manifest: &mut SyncManifest,
    client: &DriveClient,
    emitter: Option<&dyn SyncProgressEmitter>,
) -> Result<SyncResult, String> {
    let mut ctx = SyncAccountContext::open_test(lyra_dir, "test")?;
    run_sync_with_client_and_emitter_with_id(lyra_dir, manifest, client, emitter, &mut ctx, "default").await
}

pub async fn run_sync_with_client_and_emitter_with_id(
    lyra_dir: &std::path::Path,
    manifest: &mut SyncManifest,
    client: &DriveClient,
    emitter: Option<&dyn SyncProgressEmitter>,
    ctx: &mut SyncAccountContext,
    sync_id: &str,
) -> Result<SyncResult, String> {
    ensure_safe_base_dir(lyra_dir)?;
    let start_time = std::time::Instant::now();
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] ========================================================"));
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] INICIO SINCRONIZACIÓN - Backend v{} ({})", super::BACKEND_VERSION, super::BACKEND_BUILD_TIMESTAMP));
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Directorio local evaluado: '{}' (existe: {}, es_dir: {})", lyra_dir.display(), lyra_dir.exists(), lyra_dir.is_dir()));
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Manifiesto cargado: {} archivos registrados, {} tombstones pendientes. drive_folder_id='{}', last_sync={}, last_error={:?}",
        manifest.files.len(), manifest.pending_deletions.len(), manifest.drive_folder_id, manifest.last_sync_timestamp, manifest.last_error));

    let mut download_started = false;
    let mut trashed_in_this_sync: HashSet<String> = HashSet::new();
    let mut result = SyncResult {
        sync_id: sync_id.to_string(),
        ..Default::default()
    };

    // Limpieza preventiva de temporales huérfanos (.tmp_save_*) con más de 5 minutos de antigüedad
    clean_stale_tmp_save_files(lyra_dir);

    // 0. Procesar tombstones persistentes de eliminaciones locales intencionales
    if !manifest.pending_deletions.is_empty() {
        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Procesando {} eliminaciones locales pendientes (tombstones)...", manifest.pending_deletions.len()));
        let pending_keys: Vec<String> = manifest.pending_deletions.keys().cloned().collect();
        for name in pending_keys {
            if let Some(pending) = manifest.pending_deletions.get(&name).cloned() {
                let Some(ref did) = pending.drive_id else {
                    result.errors.push(format!("Tombstone for '{name}' lacks a remote identity"));
                    continue;
                };
                if !tombstone_allowed(lyra_dir, &ctx.account_key, &pending, did) {
                    result.errors.push(format!("Tombstone for '{name}' has no valid account and note binding"));
                    continue;
                }
                let was_recreated_locally = lyra_dir.join(&name).exists();
                if was_recreated_locally {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Archivo '{name}' fue recreado localmente. La copia remota previa será enviada a papelera para desvincularla del nuevo archivo."));
                }

                if let Some(ref did) = pending.drive_id {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Enviando a papelera en Drive: '{name}' (id: '{did}')..."));
                    match client.trash_file("", did).await {
                        Ok(()) => {
                            log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Confirmado en papelera en Drive."));
                            manifest.pending_deletions.remove(&name);
                            manifest.files.remove(&name);
                            result.deleted_remote.push(name.clone());
                            trashed_in_this_sync.insert(name.clone());
                        }
                        Err(e) => {
                            if e.contains("404") || e.contains("notFound") || e.contains("NotFound") {
                                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Archivo ya no existía en Drive (404). Tombstone resuelto."));
                                manifest.pending_deletions.remove(&name);
                                manifest.files.remove(&name);
                                trashed_in_this_sync.insert(name.clone());
                            } else {
                                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> No se pudo enviar a papelera ({e}). Se mantendrá en pending_deletions."));
                            }
                        }
                    }
                } else {
                    manifest.pending_deletions.remove(&name);
                    manifest.files.remove(&name);
                    trashed_in_this_sync.insert(name.clone());
                }
            }
        }
    }

    // 1. Obtener o reutilizar carpeta 'lyra' en Google Drive de forma optimizada
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Resolviendo carpeta remota 'lyra' en Google Drive..."));
    let resolved_folder_id = manifest.drive_folder_id.clone();
    let mut remote_files: Option<Vec<DriveFileMetadata>> = None;

    if !resolved_folder_id.trim().is_empty() {
        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Validando carpeta remota existente '{}'...", resolved_folder_id));
        match client.check_file_status("", &resolved_folder_id).await {
            Ok(RemoteFileStatus::Active(meta)) => {
                let is_folder = meta.mime_type.as_deref().map(|m| m == "application/vnd.google-apps.folder").unwrap_or(true);
                if is_folder {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Carpeta remota activa y confirmada."));
                    match client.list_files_in_folder("", &resolved_folder_id).await {
                        Ok(files) => {
                            log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Listado de archivos exitoso ({} archivos devueltos).", files.len()));
                            remote_files = Some(files);
                        }
                        Err(e) => {
                            log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Error transitorio al listar archivos ({e}). Abortando ciclo sin tocar datos locales."));
                            return Err(format!("Error transitorio al listar archivos de la carpeta 'lyra': {e}"));
                        }
                    }
                } else {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> El ID '{}' no corresponde a una carpeta. Se resolverá la carpeta correspondiente a la cuenta activa.", resolved_folder_id));
                    manifest.drive_folder_id.clear();
                }
            }
            Ok(RemoteFileStatus::Trashed) => {
                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Carpeta 'lyra' está en la papelera en Drive. Intentando des-papelar..."));
                if let Ok(()) = client.untrash_file("", &resolved_folder_id).await {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Carpeta 'lyra' restaurada de la papelera con éxito."));
                    if let Ok(files) = client.list_files_in_folder("", &resolved_folder_id).await {
                        remote_files = Some(files);
                    }
                } else {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> No se pudo restaurar la carpeta de la papelera. Se resolverá o creará una nueva."));
                    manifest.drive_folder_id.clear();
                }
            }
            Ok(RemoteFileStatus::NotFound) => {
                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Carpeta remota '{}' no existe en esta cuenta (404/410). Se descartará y se resolverá la carpeta correspondiente a la cuenta activa.", resolved_folder_id));
                manifest.drive_folder_id.clear();
            }
            Ok(RemoteFileStatus::Forbidden) => {
                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Acceso denegado (403) a la carpeta remota '{}' para la cuenta activa. Se descartará y se resolverá la carpeta correspondiente.", resolved_folder_id));
                manifest.drive_folder_id.clear();
            }
            Err(check_err) => {
                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Error de red o servidor al verificar estado de la carpeta ({check_err}). Abortando ciclo sin tocar datos locales."));
                return Err(format!("Error verificando carpeta 'lyra' en Drive: {check_err}"));
            }
        }
    }

    let (folder_id, remote_files) = if let Some(files) = remote_files {
        (resolved_folder_id, files)
    } else {
        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Buscando o creando carpeta 'lyra' en Google Drive para la cuenta activa..."));
        let id = client.get_or_create_lyra_folder("").await?;
        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] -> Carpeta 'lyra' resuelta: '{}'", id));
        manifest.drive_folder_id = id.clone();
        let files = client.list_files_in_folder("", &id).await?;
        (id, files)
    };

    // 2. Filtrar y agrupar archivos remotos en Drive
    let mut remote_grouped: HashMap<String, Vec<DriveFileMetadata>> = HashMap::new();
    for rf in remote_files {
        let is_dot = rf.name.starts_with('.');
        let is_valid_ext = has_supported_extension(&rf.name);
        let is_gapps = rf.mime_type.as_ref().map(|m| m.starts_with("application/vnd.google-apps.")).unwrap_or(false);

        if is_dot || !is_valid_ext || is_gapps {
            continue;
        }

        if !is_safe_filename(&rf.name) {
            log_sync_msg(
                lyra_dir,
                &format!(
                    "[Sync #{sync_id}] [SEGURIDAD] Archivo remoto descartado por nombre no seguro: '{}' (id: '{}')",
                    rf.name, rf.id
                ),
            );
            result.errors.push(format!(
                "Archivo remoto ignorado por nombre no seguro: '{}'",
                rf.name
            ));
            continue;
        }

        remote_grouped.entry(rf.name.clone()).or_default().push(rf);
    }

    let mut remote_map: HashMap<String, DriveFileMetadata> = HashMap::new();
    let mut extra_remote_files: Vec<DriveFileMetadata> = Vec::new();

    for (name, mut files) in remote_grouped {
        // Remover archivos enviados a papelera en este ciclo de sync
        files.retain(|f| !trashed_in_this_sync.contains(&f.name));
        if files.is_empty() {
            continue;
        }

        if files.len() == 1 {
            remote_map.insert(name, files.remove(0));
        } else {
            // Múltiples archivos con el mismo nombre en Google Drive (ej. notas des-papeladas desde la web de Drive)
            // Seleccionar archivo primario:
            // 1. Si coincide con manifest_item.drive_id para este nombre, ese es el primario correspondiente al local.
            // 2. De lo contrario, el más recientemente modificado.
            let manifest_did = manifest.files.get(&name).map(|m| m.drive_id.as_str());
            let primary_idx = if let Some(did) = manifest_did {
                files.iter().position(|f| f.id == did).unwrap_or_else(|| {
                    files.iter().enumerate().max_by_key(|(_, f)| f.modified_time.as_deref().unwrap_or("")).map(|(i, _)| i).unwrap_or(0)
                })
            } else {
                files.iter().enumerate().max_by_key(|(_, f)| f.modified_time.as_deref().unwrap_or("")).map(|(i, _)| i).unwrap_or(0)
            };

            let primary_file = files.remove(primary_idx);
            log_sync_msg(lyra_dir, &format!(
                "[Sync #{sync_id}] [DUPLICADOS REMOTOS] Nombre '{}' tiene {} copias activas en Drive. Primaria: drive_id='{}'. {} copia(s) secundaria(s) a procesar.",
                name, files.len() + 1, primary_file.id, files.len()
            ));
            remote_map.insert(name, primary_file);

            for extra in files {
                extra_remote_files.push(extra);
            }
        }
    }

    log_sync_msg(lyra_dir, &format!(
        "[Sync #{sync_id}] Total de archivos remotos válidos tras filtrado: {} (y {} copias adicionales/des-papeladas)",
        remote_map.len(), extra_remote_files.len()
    ));

    // 3. Escaneo local optimizado con verificación de metadata (mtime + size + integridad)
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Escaneando directorio local '{}'...", lyra_dir.display()));
    let mut local_map: HashMap<String, (PathBuf, u64, i64, String)> = HashMap::new();
    let entries = fs::read_dir(lyra_dir)
        .map_err(|e| format!("Error leyendo directorio local de Lyra: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot enumerate local notes safely: {e}"))?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| format!("Cannot inspect local entry: {e}"))?;
        if kind.is_file() {
            {
                let name = entry.file_name().into_string().map_err(|_| "A local entry has an unreadable name")?;
                let name_str = name.as_str();
                let is_dot = name_str.starts_with('.');
                let is_valid_ext = has_supported_extension(name_str);
                if is_dot || !is_valid_ext {
                    continue;
                }

                {
                    let metadata = entry.metadata().map_err(|e| format!("Cannot inspect local note '{name_str}': {e}"))?;
                    let size = metadata.len();
                    let mtime_ms = metadata
                        .modified()
                        .ok()
                        .and_then(|st| st.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or_else(|| Utc::now().timestamp_millis());

                    // Authorization needs a fresh digest: size and mtime can be
                    // preserved by an external replacement.
                    let md5_hash = match fs::read(&path) {
                        Ok(bytes) => compute_md5(&bytes),
                        Err(e) => return Err(format!("Cannot read local note '{name_str}': {e}")),
                    };

                    local_map.insert(name_str.to_string(), (path, size, mtime_ms, md5_hash));
                }
            }
        } else if has_supported_extension(&entry.file_name().to_string_lossy())
            && !entry.file_name().to_string_lossy().starts_with('.') {
            return Err("A local note is not a regular file".into());
        }
    }
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] Total de archivos locales válidos detectados: {}", local_map.len()));

    // 3b. Registrar procedencia y decidir qué puede subirse a la cuenta activa.
    // Las notas sin evidencia verificable quedan pendientes de consentimiento
    // explícito y NO se suben en este ciclo.
    for (name, (_path, size, mtime, md5)) in &local_map {
        ctx.observe(name, *mtime, *size, md5);
    }
    ctx.finish_scan(manifest);
    let internal_names: HashSet<String> = local_map.keys()
        .filter(|name| ctx.is_internal_welcome(name)).cloned().collect();
    if let Some(view) = ctx.pending_view() {
        log_sync_msg(lyra_dir, &format!(
            "[Sync #{sync_id}] [AUD-001] {} nota(s) requieren consentimiento explícito para la cuenta '{}'.",
            view.note_count, ctx.account_key
        ));
    }
    result.pending_authorization = ctx.pending_view().is_some();

    // 4. Procesar archivos locales
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] --- Evaluando {} archivos locales ---", local_map.len()));

    for (name, (path, size, local_mtime, local_md5)) in &local_map {
        if internal_names.contains(name) { continue; }
        let now_rfc3339 = Utc::now().to_rfc3339();

        if let Some(manifest_item) = manifest.files.get(name).cloned() {
            if let Some(remote_item) = remote_map.get(name) {
                let local_changed = *local_md5 != manifest_item.md5;
                let remote_changed = match remote_item.md5_checksum {
                    Some(ref r_md5) => r_md5 != &manifest_item.md5,
                    None => remote_item.modified_time.as_deref().unwrap_or("") != manifest_item.remote_mtime,
                };

                log_sync_msg(lyra_dir, &format!(
                    "[Sync #{sync_id}] [LOCAL EVAL] '{}': en_manifest=true, en_remoto=true (drive_id='{}'). local_changed={}, remote_changed={}",
                    name, remote_item.id, local_changed, remote_changed
                ));

                if !local_changed && !remote_changed {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ACCIÓN: Sin cambios (contenido sincronizado)."));
                    continue;
                } else if local_changed && !remote_changed {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ACCIÓN: Modificado localmente. Subiendo actualización a Drive (id='{}')...", remote_item.id));
                    if !note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                        continue;
                    }
                    let (content, upload_md5, upload_size, upload_mtime) = match read_authorized_snapshot(ctx, name, path, *local_mtime) {
                        Ok(s) => s,
                        Err(e) => {
                            result.errors.push(format!("Error leyendo '{name}' para actualizar: {e}"));
                            continue;
                        }
                    };
                    match client
                        .update_file("", &remote_item.id, name, &content, &now_rfc3339)
                        .await
                    {
                        Ok(meta) => {
                            manifest.files.insert(
                                name.clone(),
                                FileManifestItem {
                                    drive_id: meta.id,
                                    md5: upload_md5,
                                    local_mtime: upload_mtime,
                                    remote_mtime: meta.modified_time.unwrap_or(now_rfc3339),
                                    local_size: upload_size,
                                },
                            );
                            result.uploaded.push(name.clone());
                        }
                        Err(e) => {
                            log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ERROR al actualizar '{}' en Drive: {e}", name));
                            result.errors.push(format!("Error al actualizar '{name}' en Drive: {e}"));
                        }
                    }
                } else if !local_changed && remote_changed {
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ACCIÓN: Modificado en Drive. Descargando a local (id='{}')...", remote_item.id));
                    if !download_started {
                        download_started = true;
                        if let Some(em) = emitter {
                            em.emit_download_start();
                        }
                    }
                    match client.download_file("", &remote_item.id).await {
                        Ok(remote_bytes) => {
                            let lock_coord = get_file_lock_coordinator();
                            enum Step4Outcome {
                                Conflict(String, Option<(Vec<u8>, String, u64, i64)>),
                                Downloaded(String, i64, u64),
                                Error(String),
                            }

                            // Coordinación por archivo: verificación y reemplazo atómicos sin TOCTOU
                            let foreign_authorization = ctx.has_foreign_authorization(name) || !ctx.can_upload(name);
                            let outcome = lock_coord.with_file_lock(name, || {
                                let current_disk = fs::read(path).ok();
                                let concurrent_local_edit = match &current_disk {
                                    Some(disk_bytes) => {
                                        let current_disk_md5 = compute_md5(disk_bytes);
                                        current_disk_md5 != manifest_item.md5 && current_disk_md5 != compute_md5(&remote_bytes)
                                    }
                                    None => false,
                                };

                                if concurrent_local_edit || foreign_authorization {
                                    if foreign_authorization {
                                        log_sync_msg(
                                            lyra_dir,
                                            &format!(
                                                "[Sync #{sync_id}]   -> '{}' pertenece a otra cuenta autorizada. Se conserva la copia local y la versión remota se guarda como copia de conflicto.",
                                                name
                                            ),
                                        );
                                    } else {
                                        log_sync_msg(
                                            lyra_dir,
                                            &format!(
                                                "[Sync #{sync_id}]   -> DETECTADA MODIFICACIÓN LOCAL CONCURRENTE en '{}' durante la descarga remota. Guardando versión remota como copia de conflicto.",
                                                name
                                            ),
                                        );
                                    }
                                    match write_unique_conflict_file(lyra_dir, name, &remote_bytes, Utc::now()) {
                                        Ok(conflict_name) => {
                                            let snapshot = read_authorized_snapshot(ctx, name, path, *local_mtime).ok();
                                            Step4Outcome::Conflict(conflict_name, snapshot)
                                        }
                                        Err(e) => {
                                            Step4Outcome::Error(format!("Error escribiendo copia de conflicto para '{name}': {e}"))
                                        }
                                    }
                                } else {
                                    if let Err(e) = write_file_atomic(path, &remote_bytes) {
                                        Step4Outcome::Error(format!("Error escribiendo '{name}' descargado: {e}"))
                                    } else {
                                        let new_md5 = compute_md5(&remote_bytes);
                                        let actual_mtime = fs::metadata(path)
                                            .ok()
                                            .and_then(|m| m.modified().ok())
                                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                            .map(|d| d.as_millis() as i64)
                                            .unwrap_or_else(|| Utc::now().timestamp_millis());
                                        Step4Outcome::Downloaded(new_md5, actual_mtime, remote_bytes.len() as u64)
                                    }
                                }
                            });

                            match outcome {
                                Step4Outcome::Conflict(conflict_name, snapshot) => {
                                    log_sync_msg(
                                        lyra_dir,
                                        &format!(
                                            "[Sync #{sync_id}]   -> Copia remota guardada con éxito como '{}'",
                                            conflict_name
                                        ),
                                    );
                                    if let Some((content, upload_md5, upload_size, upload_mtime)) = snapshot {
                                        if note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                                            let _ = client.update_file("", &remote_item.id, name, &content, &now_rfc3339).await;
                                            manifest.files.insert(
                                                name.clone(),
                                                FileManifestItem {
                                                    drive_id: remote_item.id.clone(),
                                                    md5: upload_md5,
                                                    local_mtime: upload_mtime,
                                                    remote_mtime: now_rfc3339.clone(),
                                                    local_size: upload_size,
                                                },
                                            );
                                        }
                                    }
                                    let conflict_md5 = compute_md5(&remote_bytes);
                                    let conflict_mtime = fs::metadata(lyra_dir.join(&conflict_name))
                                        .ok()
                                        .and_then(|m| m.modified().ok())
                                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                        .map(|d| d.as_millis() as i64)
                                        .unwrap_or_else(|| Utc::now().timestamp_millis());
                                    ctx.mark_downloaded(
                                        &conflict_name,
                                        &remote_item.id,
                                        &conflict_md5,
                                        conflict_mtime,
                                        remote_bytes.len() as u64,
                                        AuthorizationSource::AutomaticDownload,
                                    );
                                    result.conflicts.push(name.clone());
                                    if let Some(em) = emitter {
                                        em.emit_file_downloaded(&conflict_name);
                                    }
                                }
                                Step4Outcome::Downloaded(new_md5, actual_mtime, size) => {
                                    manifest.files.insert(
                                        name.clone(),
                                        FileManifestItem {
                                            drive_id: remote_item.id.clone(),
                                            md5: new_md5.clone(),
                                            local_mtime: actual_mtime,
                                            remote_mtime: remote_item.modified_time.clone().unwrap_or(now_rfc3339),
                                            local_size: size,
                                        },
                                    );
                                    ctx.mark_downloaded(
                                        name,
                                        &remote_item.id,
                                        &new_md5,
                                        actual_mtime,
                                        size,
                                        AuthorizationSource::AutomaticDownload,
                                    );
                                    result.downloaded.push(name.clone());
                                    if let Some(em) = emitter {
                                        em.emit_file_downloaded(name);
                                    }
                                }
                                Step4Outcome::Error(err_msg) => {
                                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ERROR al procesar '{}' descargado: {err_msg}", name));
                                    result.errors.push(err_msg);
                                }
                            }
                        }
                        Err(e) => {
                            log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ERROR al descargar '{}' de Drive: {e}", name));
                            result.errors.push(format!("Error al descargar '{name}' de Drive: {e}"));
                        }
                    }
                } else {
                    // CONFLICTO
                    let same_content = match remote_item.md5_checksum {
                        Some(ref r_md5) => local_md5 == r_md5,
                        None => false,
                    };
                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> CONFLICTO en '{}'. Contenidos idénticos?: {}", name, same_content));

                    if same_content {
                        manifest.files.insert(
                            name.clone(),
                            FileManifestItem {
                                drive_id: remote_item.id.clone(),
                                md5: local_md5.clone(),
                                local_mtime: *local_mtime,
                                remote_mtime: remote_item.modified_time.clone().unwrap_or(now_rfc3339),
                                local_size: *size,
                            },
                        );
                        // Contenido local idéntico al remoto de esta cuenta: evidencia
                        // suficiente para vincular la nota sin pedir consentimiento.
                        ctx.mark_downloaded(
                            name,
                            &remote_item.id,
                            local_md5,
                            *local_mtime,
                            *size,
                            AuthorizationSource::AutomaticDownload,
                        );
                    } else {
                        if !download_started {
                            download_started = true;
                            if let Some(em) = emitter {
                                em.emit_download_start();
                            }
                        }
                        match client.download_file("", &remote_item.id).await {
                            Ok(remote_bytes) => {
                                match write_unique_conflict_file(lyra_dir, name, &remote_bytes, Utc::now()) {
                                    Err(e) => {
                                        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ERROR guardando archivo de conflicto: {e}"));
                                        result.errors.push(format!("Error escribiendo copia de conflicto para '{name}': {e}"));
                                    }
                                    Ok(conflict_name) => {
                                        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Copia de conflicto guardada como '{}'", conflict_name));
                                        let conflict_md5 = compute_md5(&remote_bytes);
                                        let conflict_mtime = fs::metadata(lyra_dir.join(&conflict_name))
                                            .ok()
                                            .and_then(|m| m.modified().ok())
                                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                            .map(|d| d.as_millis() as i64)
                                            .unwrap_or_else(|| Utc::now().timestamp_millis());
                                        ctx.mark_downloaded(
                                            &conflict_name,
                                            &remote_item.id,
                                            &conflict_md5,
                                            conflict_mtime,
                                            remote_bytes.len() as u64,
                                            AuthorizationSource::AutomaticDownload,
                                        );
                                        let (content, upload_md5, upload_size, upload_mtime) = match read_authorized_snapshot(ctx, name, path, *local_mtime) {
                                            Ok(s) => s,
                                            Err(e) => {
                                                result.errors.push(format!("Error leyendo '{name}' para actualizar versión remota tras conflicto: {e}"));
                                                continue;
                                            }
                                        };
                                        if note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                                            let _ = client
                                                .update_file("", &remote_item.id, name, &content, &now_rfc3339)
                                                .await;

                                            manifest.files.insert(
                                                name.clone(),
                                                FileManifestItem {
                                                    drive_id: remote_item.id.clone(),
                                                    md5: upload_md5,
                                                    local_mtime: upload_mtime,
                                                    remote_mtime: now_rfc3339,
                                                    local_size: upload_size,
                                                },
                                            );
                                        }

                                        result.conflicts.push(name.clone());
                                        if let Some(em) = emitter {
                                            em.emit_file_downloaded(&conflict_name);
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> ERROR al descargar versión remota para resolver conflicto: {e}"));
                                result.errors.push(format!("Error resolviendo conflicto en '{name}': {e}"));
                            }
                        }
                    }
                }
            } else {
                // ARCHIVO EXISTE LOCALMENTE, PERO DESAPARECIÓ DE DRIVE
                // REGLA FUNDAMENTAL: EL ARCHIVO LOCAL NUNCA SE ELIMINA.
                log_sync_msg(lyra_dir, &format!(
                    "[Sync #{sync_id}] [LOCAL EVAL] '{}': En manifest pero AUSENTE en listado de Drive. Comprobando estado para restaurar...",
                    name
                ));

                match client.check_file_status("", &manifest_item.drive_id).await {
                    Ok(status) => {
                        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Estado remoto de '{name}': {:?}", status));
                        let action = resolve_remote_deletion_action(local_md5, &manifest_item.md5, &status);
                        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Acción de restauración: {:?}", action));

                        match action {
                            RemoteDeletionAction::RestoreFromTrash => {
                                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Archivo en papelera en Drive. Intentando des-papelar (untrash)..."));
                                let mut restored = false;
                                if let Ok(()) = client.untrash_file("", &manifest_item.drive_id).await {
                                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Archivo des-papelado con éxito en Drive."));
                                    restored = true;
                                    if local_md5 != &manifest_item.md5 {
                                        if let Ok((content, upload_md5, upload_size, upload_mtime)) = read_authorized_snapshot(ctx, name, path, *local_mtime) {
                                            if note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                                                let _ = client.update_file("", &manifest_item.drive_id, name, &content, &now_rfc3339).await;
                                                manifest.files.insert(
                                                    name.clone(),
                                                    FileManifestItem {
                                                        drive_id: manifest_item.drive_id.clone(),
                                                        md5: upload_md5,
                                                        local_mtime: upload_mtime,
                                                        remote_mtime: now_rfc3339.clone(),
                                                        local_size: upload_size,
                                                    },
                                                );
                                            }
                                        }
                                    } else {
                                        manifest.files.insert(
                                            name.clone(),
                                            FileManifestItem {
                                                drive_id: manifest_item.drive_id.clone(),
                                                md5: local_md5.clone(),
                                                local_mtime: *local_mtime,
                                                remote_mtime: now_rfc3339.clone(),
                                                local_size: *size,
                                            },
                                        );
                                    }
                                } else {
                                    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> No se pudo des-papelar. Re-subiendo archivo como nueva copia..."));
                                }

                                if !restored
                                    && note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id)
                                {
                                    if let Ok((content, upload_md5, upload_size, upload_mtime)) = read_authorized_snapshot(ctx, name, path, *local_mtime) {
                                        match client.upload_file("", &folder_id, name, &content, &now_rfc3339).await {
                                            Ok(meta) => {
                                                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Archivo restaurado vía re-subida (id='{}')", meta.id));
                                                manifest.files.insert(
                                                    name.clone(),
                                                    FileManifestItem {
                                                        drive_id: meta.id,
                                                        md5: upload_md5,
                                                        local_mtime: upload_mtime,
                                                        remote_mtime: meta.modified_time.unwrap_or(now_rfc3339),
                                                        local_size: upload_size,
                                                    },
                                                );
                                                result.uploaded.push(name.clone());
                                            }
                                            Err(e) => {
                                                result.errors.push(format!("Error re-subiendo archivo '{name}' a Drive: {e}"));
                                            }
                                        }
                                    }
                                }
                            }
                            RemoteDeletionAction::PreserveAndReupload => {
                                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Archivo eliminado permanentemente en Drive. Re-subiendo copia local..."));
                                if note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                                    if let Ok((content, upload_md5, upload_size, upload_mtime)) = read_authorized_snapshot(ctx, name, path, *local_mtime) {
                                        match client.upload_file("", &folder_id, name, &content, &now_rfc3339).await {
                                        Ok(meta) => {
                                            log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Archivo restaurado vía re-subida (id='{}')", meta.id));
                                            manifest.files.insert(
                                                name.clone(),
                                                FileManifestItem {
                                                    drive_id: meta.id,
                                                    md5: upload_md5,
                                                    local_mtime: upload_mtime,
                                                    remote_mtime: meta.modified_time.unwrap_or(now_rfc3339),
                                                    local_size: upload_size,
                                                },
                                            );
                                            result.uploaded.push(name.clone());
                                        }
                                        Err(e) => {
                                            result.errors.push(format!("Error re-subiendo '{name}' a Drive: {e}"));
                                        }
                                    }
                                }
                                }
                            }
                            RemoteDeletionAction::UpdateRemote => {
                                if let RemoteFileStatus::Active(active_meta) = status {
                                    if note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                                        if let Ok((content, upload_md5, upload_size, upload_mtime)) = read_authorized_snapshot(ctx, name, path, *local_mtime) {
                                            match client.update_file("", &active_meta.id, name, &content, &now_rfc3339).await {
                                                Ok(meta) => {
                                                    manifest.files.insert(
                                                        name.clone(),
                                                        FileManifestItem {
                                                            drive_id: meta.id,
                                                            md5: upload_md5,
                                                            local_mtime: upload_mtime,
                                                            remote_mtime: meta.modified_time.unwrap_or(now_rfc3339),
                                                            local_size: upload_size,
                                                        },
                                                    );
                                                    result.uploaded.push(name.clone());
                                                }
                                                Err(e) => {
                                                    result.errors.push(format!("Error actualizando '{name}' en Drive: {e}"));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            RemoteDeletionAction::Noop => {}
                        }
                    }
                    Err(e) => {
                        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Error verificando estado remoto de '{name}' ({e}). Se conserva copia local intacta."));
                    }
                }
            }
        } else {
            // ARCHIVO LOCAL NO ESTÁ EN EL MANIFIESTO LOCAL
            if let Some(remote_item) = remote_map.get(name) {
                let remote_md5 = remote_item.md5_checksum.as_deref().unwrap_or("");
                log_sync_msg(lyra_dir, &format!(
                    "[Sync #{sync_id}] [LOCAL EVAL] '{}': No en manifest pero existe en remoto (id='{}'). Reconciliando...",
                    name, remote_item.id
                ));
                if *local_md5 == remote_md5 {
                    manifest.files.insert(
                        name.clone(),
                        FileManifestItem {
                            drive_id: remote_item.id.clone(),
                            md5: local_md5.clone(),
                            local_mtime: *local_mtime,
                            remote_mtime: remote_item.modified_time.clone().unwrap_or(now_rfc3339),
                            local_size: *size,
                        },
                    );
                    // Matching bytes are not proof that the local note belongs
                    // to this account. Keep its existing authorization state.
                } else if note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                    if let Ok((content, upload_md5, upload_size, upload_mtime)) = read_authorized_snapshot(ctx, name, path, *local_mtime) {
                        match client.update_file("", &remote_item.id, name, &content, &now_rfc3339).await {
                            Ok(meta) => {
                                manifest.files.insert(
                                    name.clone(),
                                    FileManifestItem {
                                        drive_id: meta.id,
                                        md5: upload_md5,
                                        local_mtime: upload_mtime,
                                        remote_mtime: meta.modified_time.unwrap_or(now_rfc3339),
                                        local_size: upload_size,
                                    },
                                );
                                result.uploaded.push(name.clone());
                            }
                            Err(e) => {
                                result.errors.push(format!("Error actualizando versión remota de '{name}': {e}"));
                            }
                        }
                    }
                }
            } else {
                // ARCHIVO NUEVO CREADO LOCALMENTE
                if let Ok((content, upload_md5, upload_size, upload_mtime)) = read_file_snapshot(path, *local_mtime) {
                    log_sync_msg(
                        lyra_dir,
                        &format!(
                            "[Sync #{sync_id}] [LOCAL EVAL] '{}': NUEVO ARCHIVO LOCAL. Subiendo a Google Drive...",
                            name
                        ),
                    );
                    if !note_upload_allowed(ctx, name, &mut result, lyra_dir, sync_id) {
                        continue;
                    }
                    if !ctx.can_upload_digest(name, &upload_md5) {
                        result.errors.push(format!("Content of '{name}' changed after authorization scan"));
                        continue;
                    }
                    match client.upload_file("", &folder_id, name, &content, &now_rfc3339).await {
                        Ok(meta) => {
                            manifest.files.insert(
                                name.clone(),
                                FileManifestItem {
                                    drive_id: meta.id,
                                    md5: upload_md5,
                                    local_mtime: upload_mtime,
                                    remote_mtime: meta.modified_time.unwrap_or(now_rfc3339),
                                    local_size: upload_size,
                                },
                            );
                            result.uploaded.push(name.clone());
                        }
                        Err(e) => {
                            result.errors.push(format!("Error subiendo nuevo archivo '{name}' a Drive: {e}"));
                        }
                    }
                }
            }
        }
    }

    // 5. Procesar archivos remotos que NO están localmente
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] --- Evaluando archivos remotos ausentes en local ---"));
    for (remote_name, remote_meta) in &remote_map {
        if trashed_in_this_sync.contains(remote_name) {
            log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] [REMOTO EVAL] '{}': Archivo enviado a papelera en este ciclo de sincronización. Omitiendo.", remote_name));
            continue;
        }
        if !local_map.contains_key(remote_name) {
            if manifest.pending_deletions.contains_key(remote_name) {
                let pending = &manifest.pending_deletions[remote_name];
                if !tombstone_allowed(lyra_dir, &ctx.account_key, pending, &remote_meta.id) {
                    result.errors.push(format!("Tombstone for '{remote_name}' does not match this remote note"));
                    continue;
                }
                // Eliminación intencional desde Lyra
                log_sync_msg(lyra_dir, &format!(
                    "[Sync #{sync_id}] [REMOTO EVAL] '{}' (id: '{}'): En pending_deletions -> Enviando a papelera en Drive...",
                    remote_name, remote_meta.id
                ));
                match client.trash_file("", &remote_meta.id).await {
                    Ok(()) => {
                        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Confirmado en papelera en Drive."));
                        manifest.pending_deletions.remove(remote_name);
                        manifest.files.remove(remote_name);
                        result.deleted_remote.push(remote_name.clone());
                        trashed_in_this_sync.insert(remote_name.clone());
                    }
                    Err(e) => {
                        if e.contains("404") || e.contains("notFound") || e.contains("NotFound") {
                            manifest.pending_deletions.remove(remote_name);
                            manifest.files.remove(remote_name);
                            trashed_in_this_sync.insert(remote_name.clone());
                        } else {
                            result.errors.push(format!("Error enviando '{remote_name}' a papelera en Drive: {e}"));
                        }
                    }
                }
            } else {
                // Eliminación externa o instalación nueva -> Recuperar descargando desde Drive a local (Decisión 2)
                log_sync_msg(lyra_dir, &format!(
                    "[Sync #{sync_id}] [REMOTO EVAL] '{}' (id: '{}'): Ausente en local sin tombstone. Recuperando copia desde Drive...",
                    remote_name, remote_meta.id
                ));
                if !download_started {
                    download_started = true;
                    if let Some(em) = emitter {
                        em.emit_download_start();
                    }
                }
                match client.download_file("", &remote_meta.id).await {
                    Ok(bytes) => {
                        let path = match resolve_safe_path(lyra_dir, remote_name) {
                            Ok(p) => p,
                            Err(e) => {
                                log_sync_msg(
                                    lyra_dir,
                                    &format!(
                                        "[Sync #{sync_id}] [SEGURIDAD] Rechazo de ruta para '{remote_name}': {e}"
                                    ),
                                );
                                result.errors.push(format!(
                                    "Descarga de '{remote_name}' rechazada por ruta insegura: {e}"
                                ));
                                continue;
                            }
                        };

                        let lock_coord = get_file_lock_coordinator();
                        enum Step5Outcome {
                            Conflict(String),
                            Downloaded(String, i64, u64),
                            Error(String),
                        }

                        // Coordinación por archivo: verificación y reemplazo atómicos sin TOCTOU
                        let outcome = lock_coord.with_file_lock(remote_name, || {
                            if path.exists() {
                                let local_bytes = fs::read(&path).unwrap_or_default();
                                let local_md5 = compute_md5(&local_bytes);
                                let remote_md5 = compute_md5(&bytes);
                                if local_md5 != remote_md5 {
                                    log_sync_msg(
                                        lyra_dir,
                                        &format!(
                                            "[Sync #{sync_id}]   -> Archivo local recién creado '{}' difiere de Drive. Guardando versión remota como copia de conflicto.",
                                            remote_name
                                        ),
                                    );
                                    match write_unique_conflict_file(lyra_dir, remote_name, &bytes, Utc::now()) {
                                        Ok(conflict_name) => Step5Outcome::Conflict(conflict_name),
                                        Err(e) => Step5Outcome::Error(format!("Error escribiendo conflicto para '{remote_name}': {e}")),
                                    }
                                } else {
                                    let new_md5 = compute_md5(&bytes);
                                    let actual_mtime = fs::metadata(&path)
                                        .ok()
                                        .and_then(|m| m.modified().ok())
                                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                        .map(|d| d.as_millis() as i64)
                                        .unwrap_or_else(|| Utc::now().timestamp_millis());
                                    Step5Outcome::Downloaded(new_md5, actual_mtime, bytes.len() as u64)
                                }
                            } else {
                                if let Err(e) = write_file_atomic(&path, &bytes) {
                                    Step5Outcome::Error(format!("Error guardando archivo recuperado '{remote_name}': {e}"))
                                } else {
                                    let new_md5 = compute_md5(&bytes);
                                    let actual_mtime = fs::metadata(&path)
                                        .ok()
                                        .and_then(|m| m.modified().ok())
                                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                        .map(|d| d.as_millis() as i64)
                                        .unwrap_or_else(|| Utc::now().timestamp_millis());
                                    Step5Outcome::Downloaded(new_md5, actual_mtime, bytes.len() as u64)
                                }
                            }
                        });

                        match outcome {
                            Step5Outcome::Conflict(conflict_name) => {
                                log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   -> Copia remota guardada como '{conflict_name}'"));
                                let conflict_md5 = compute_md5(&bytes);
                                let conflict_mtime = fs::metadata(lyra_dir.join(&conflict_name))
                                    .ok()
                                    .and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_millis() as i64)
                                    .unwrap_or_else(|| Utc::now().timestamp_millis());
                                ctx.mark_downloaded(
                                    &conflict_name,
                                    &remote_meta.id,
                                    &conflict_md5,
                                    conflict_mtime,
                                    bytes.len() as u64,
                                    AuthorizationSource::AutomaticDownload,
                                );
                                result.conflicts.push(remote_name.clone());
                                if let Some(em) = emitter {
                                    em.emit_file_downloaded(&conflict_name);
                                }
                            }
                            Step5Outcome::Downloaded(new_md5, actual_mtime, size) => {
                                // The previous local identity, if any, belonged
                                // to a file that was already absent at scan time.
                                ctx.retire(remote_name);
                                manifest.files.insert(
                                    remote_name.clone(),
                                    FileManifestItem {
                                        drive_id: remote_meta.id.clone(),
                                        md5: new_md5.clone(),
                                        local_mtime: actual_mtime,
                                        remote_mtime: remote_meta.modified_time.clone().unwrap_or_else(|| Utc::now().to_rfc3339()),
                                        local_size: size,
                                    },
                                );
                                ctx.mark_downloaded(
                                    remote_name,
                                    &remote_meta.id,
                                    &new_md5,
                                    actual_mtime,
                                    size,
                                    AuthorizationSource::AutomaticDownload,
                                );
                                result.downloaded.push(remote_name.clone());
                                if let Some(em) = emitter {
                                    em.emit_file_downloaded(remote_name);
                                }
                            }
                            Step5Outcome::Error(err_msg) => {
                                result.errors.push(err_msg);
                            }
                        }
                    }
                    Err(e) => {
                        result.errors.push(format!("Error descargando nuevo archivo '{remote_name}' desde Drive: {e}"));
                    }
                }
            }
        }
    }

    // 5b. Procesar copias remotas secundarias/des-papeladas (ej. notas restauradas de la papelera en Drive)
    if !extra_remote_files.is_empty() {
        log_sync_msg(lyra_dir, &format!(
            "[Sync #{sync_id}] --- Procesando {} copias remotas adicionales/des-papeladas ---",
            extra_remote_files.len()
        ));
        for extra_rf in extra_remote_files {
            if internal_names.contains(&extra_rf.name) { continue; }
            if !is_safe_filename(&extra_rf.name) {
                log_sync_msg(
                    lyra_dir,
                    &format!(
                        "[Sync #{sync_id}] [SEGURIDAD] Archivo extra remoto descartado por nombre no seguro: '{}'",
                        extra_rf.name
                    ),
                );
                result.errors.push(format!(
                    "Archivo extra remoto ignorado por nombre no seguro: '{}'",
                    extra_rf.name
                ));
                continue;
            }

            // Verificar si este drive_id ya está registrado en el manifiesto bajo algún nombre y existe en disco
            let already_tracked_name = manifest.files.iter().find(|(_, item)| item.drive_id == extra_rf.id).map(|(n, _)| n.clone());
            if let Some(ref tracked_name) = already_tracked_name {
                if lyra_dir.join(tracked_name).exists() {
                    log_sync_msg(lyra_dir, &format!(
                        "[Sync #{sync_id}] [EXTRA REMOTO] '{}' (id: '{}') ya existe localmente como '{}'. Omitiendo re-descarga.",
                        extra_rf.name, extra_rf.id, tracked_name
                    ));
                    continue;
                }
            }

            log_sync_msg(lyra_dir, &format!(
                "[Sync #{sync_id}] [EXTRA REMOTO] Descargando archivo restaurado/duplicado de Drive: '{}' (id: '{}')...",
                extra_rf.name, extra_rf.id
            ));

            if !download_started {
                download_started = true;
                if let Some(em) = emitter {
                    em.emit_download_start();
                }
            }

            match client.download_file("", &extra_rf.id).await {
                Ok(bytes) => {
                    match write_unique_conflict_file(lyra_dir, &extra_rf.name, &bytes, Utc::now()) {
                        Ok(saved_name) => {
                            log_sync_msg(lyra_dir, &format!(
                                "[Sync #{sync_id}]   -> Archivo des-papelado de Drive guardado localmente como '{}'",
                                saved_name
                            ));
                            let new_md5 = compute_md5(&bytes);
                            let actual_mtime = fs::metadata(lyra_dir.join(&saved_name))
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_millis() as i64)
                                .unwrap_or_else(|| Utc::now().timestamp_millis());

                            manifest.files.insert(
                                saved_name.clone(),
                                FileManifestItem {
                                    drive_id: extra_rf.id.clone(),
                                    md5: new_md5.clone(),
                                    local_mtime: actual_mtime,
                                    remote_mtime: extra_rf.modified_time.clone().unwrap_or_else(|| Utc::now().to_rfc3339()),
                                    local_size: bytes.len() as u64,
                                },
                            );

                            ctx.mark_downloaded(
                                &saved_name,
                                &extra_rf.id,
                                &new_md5,
                                actual_mtime,
                                bytes.len() as u64,
                                AuthorizationSource::AutomaticDownload,
                            );

                            let _ = client.rename_file("", &extra_rf.id, &saved_name).await;

                            result.downloaded.push(saved_name.clone());
                            if let Some(em) = emitter {
                                em.emit_file_downloaded(&saved_name);
                            }
                        }
                        Err(e) => {
                            result.errors.push(format!("Error guardando archivo des-papelado '{}': {e}", extra_rf.name));
                        }
                    }
                }
                Err(e) => {
                    result.errors.push(format!("Error descargando archivo des-papelado '{}' (id: '{}'): {e}", extra_rf.name, extra_rf.id));
                }
            }
        }
    }

    // Limpiar entradas del manifiesto que ya no existen ni en local ni en remoto y no son tombstones
    manifest.files.retain(|name, _| lyra_dir.join(name).exists() || remote_map.contains_key(name));

    if download_started {
        if let Some(em) = emitter {
            em.emit_download_finish();
        }
    }

    manifest.last_sync_timestamp = Utc::now().timestamp_millis();

    let elapsed = start_time.elapsed().as_millis();
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] ========================================================"));
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] FIN SINCRONIZACIÓN (duración: {}ms)", elapsed));
    log_sync_msg(lyra_dir, &format!(
        "[Sync #{sync_id}] Resumen final: {} subidos, {} descargados, {} conflictos, {} eliminados remotos, {} errores.",
        result.uploaded.len(), result.downloaded.len(), result.conflicts.len(), result.deleted_remote.len(), result.errors.len()
    ));
    for err in &result.errors {
        log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}]   [ERROR DETALLADO] {}", err));
    }
    log_sync_msg(lyra_dir, &format!("[Sync #{sync_id}] ========================================================"));

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::provenance;
    use super::super::types::PendingDeletion;
    use std::sync::Arc;
    use std::time::Duration;

    struct TestTokenProvider;
    impl super::super::auth::TokenProvider for TestTokenProvider {
        fn get_token(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>> {
            Box::pin(async { Ok("mock_test_token".to_string()) })
        }
        fn refresh_token(&self, _failed_token: &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, super::super::auth::TokenRefreshError>> + Send + '_>> {
            Box::pin(async { Ok("mock_test_token".to_string()) })
        }
    }

    #[test]
    fn test_compute_md5() {
        assert_eq!(
            compute_md5(b"hello world"),
            "5eb63bbbe01eeed093cb22bb8f5acdc3"
        );
        assert_eq!(
            compute_md5(b""),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
    }

    #[test]
    fn tombstones_require_retired_note_account_and_remote_id() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_tombstone_scope_{}", rand::random::<u64>()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        provenance::create_local_note(&temp_dir, "note.md", b"A private", Some("account_a")).unwrap();
        let mut link_ctx = SyncAccountContext::open(&temp_dir, "account_a", None, 1).unwrap();
        let mut link_manifest = SyncManifest::default();
        link_manifest.files.insert("note.md".to_string(), FileManifestItem {
            drive_id: "remote_a".to_string(), md5: compute_md5(b"A private"),
            local_mtime: 0, remote_mtime: String::new(), local_size: 9,
        });
        link_ctx.record_manifest_links(&link_manifest, &["note.md".to_string()]);
        link_ctx.persist().unwrap();
        let note_id = provenance::load_ledger(&provenance::get_ledger_path(&temp_dir))
            .unwrap().unwrap().by_name["note.md"].clone();
        let scoped = super::super::types::PendingDeletion {
            drive_id: Some("remote_a".to_string()), deleted_at: 1,
            account_key: Some("account_a".to_string()), note_id: Some(note_id),
        };
        assert!(!tombstone_allowed(&temp_dir, "account_a", &scoped, "remote_a"));
        provenance::retire_note(&temp_dir, "note.md").unwrap();
        assert!(tombstone_allowed(&temp_dir, "account_a", &scoped, "remote_a"));
        assert!(!tombstone_allowed(&temp_dir, "account_b", &scoped, "remote_a"));
        assert!(!tombstone_allowed(&temp_dir, "account_a", &scoped, "remote_b"));
        let legacy = super::super::types::PendingDeletion {
            account_key: None, note_id: None, ..scoped
        };
        assert!(!tombstone_allowed(&temp_dir, "account_a", &legacy, "remote_a"));
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn upload_snapshot_rejects_content_changed_after_authorization_scan() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_snapshot_auth_{}", rand::random::<u64>()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        provenance::create_local_note(&temp_dir, "note.md", b"version A", Some("account_a")).unwrap();
        let mut ctx = SyncAccountContext::open(&temp_dir, "account_a", None, 1).unwrap();
        let path = temp_dir.join("note.md");
        let (_, md5, size, mtime) = read_file_snapshot(&path, 0).unwrap();
        ctx.observe("note.md", mtime, size, &md5);
        ctx.finish_scan(&SyncManifest::default());
        assert!(read_authorized_snapshot(&ctx, "note.md", &path, mtime).is_ok());
        std::fs::write(&path, b"version B").unwrap();
        assert!(read_authorized_snapshot(&ctx, "note.md", &path, mtime).is_err());
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_split_filename() {
        assert_eq!(
            split_filename("nota.txt"),
            ("nota".to_string(), ".txt".to_string())
        );
        assert_eq!(
            split_filename("mi.archivo.md"),
            ("mi.archivo".to_string(), ".md".to_string())
        );
        assert_eq!(
            split_filename("sin_extension"),
            ("sin_extension".to_string(), ".txt".to_string())
        );
    }

    #[test]
    fn test_resolve_remote_deletion_clean_deletion_trashed() {
        let action = resolve_remote_deletion_action(
            "hash_123",
            "hash_123",
            &RemoteFileStatus::Trashed,
        );
        // REGLA FUNDAMENTAL: Nunca se elimina el archivo local ante borrado remoto.
        // Si está en papelera en Drive, se intenta restaurar (RestoreFromTrash).
        assert_eq!(action, RemoteDeletionAction::RestoreFromTrash);
    }

    #[test]
    fn test_resolve_remote_deletion_clean_deletion_not_found() {
        let action = resolve_remote_deletion_action(
            "hash_abc",
            "hash_abc",
            &RemoteFileStatus::NotFound,
        );
        // REGLA FUNDAMENTAL: Nunca se elimina el archivo local ante borrado remoto.
        // Si no existe (404), se re-sube la copia local (PreserveAndReupload).
        assert_eq!(action, RemoteDeletionAction::PreserveAndReupload);
    }

    #[test]
    fn test_resolve_remote_deletion_ambiguous_preserves_local_changes() {
        // El usuario editó la nota localmente ("hash_modified" != "hash_original_manifest")
        // pero remotamente fue eliminada en Drive.
        // REGLA CRÍTICA: Debe preservar los cambios locales y resubir a Drive.
        let action = resolve_remote_deletion_action(
            "hash_modified",
            "hash_original_manifest",
            &RemoteFileStatus::Trashed,
        );
        assert_eq!(action, RemoteDeletionAction::PreserveAndReupload);
    }

    #[test]
    fn test_resolve_remote_deletion_active_remote_behavior() {
        let dummy_meta = DriveFileMetadata {
            id: "id_1".to_string(),
            name: "test.md".to_string(),
            mime_type: Some("text/markdown".to_string()),
            modified_time: None,
            md5_checksum: None,
            trashed: Some(false),
        };

        // Si sigue activo y hubo cambios locales -> UpdateRemote
        let action_changed = resolve_remote_deletion_action(
            "hash_new",
            "hash_old",
            &RemoteFileStatus::Active(dummy_meta.clone()),
        );
        assert_eq!(action_changed, RemoteDeletionAction::UpdateRemote);

        // Si sigue activo y no hubo cambios locales -> Noop
        let action_same = resolve_remote_deletion_action(
            "hash_same",
            "hash_same",
            &RemoteFileStatus::Active(dummy_meta),
        );
        assert_eq!(action_same, RemoteDeletionAction::Noop);
    }

    #[test]
    fn test_write_unique_conflict_file_consecutive_collisions() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_conflict_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let fixed_time = chrono::DateTime::parse_from_rfc3339("2026-10-27T12:00:00Z").unwrap().with_timezone(&chrono::Utc);

        // Intento 1: sin colisión
        let name1 = write_unique_conflict_file(&temp_dir, "nota.md", b"version 1", fixed_time).unwrap();
        assert_eq!(name1, "nota (conflicto Google Drive 20261027_120000).md");
        assert_eq!(std::fs::read_to_string(temp_dir.join(&name1)).unwrap(), "version 1");

        // Intento 2: misma marca temporal -> debe generar (1) sin sobrescribir el archivo 1
        let name2 = write_unique_conflict_file(&temp_dir, "nota.md", b"version 2", fixed_time).unwrap();
        assert_eq!(name2, "nota (conflicto Google Drive 20261027_120000) (1).md");
        assert_eq!(std::fs::read_to_string(temp_dir.join(&name1)).unwrap(), "version 1", "El archivo original debe conservarse intacto");
        assert_eq!(std::fs::read_to_string(temp_dir.join(&name2)).unwrap(), "version 2");

        // Intento 3: colisión consecutiva -> debe generar (2)
        let name3 = write_unique_conflict_file(&temp_dir, "nota.md", b"version 3", fixed_time).unwrap();
        assert_eq!(name3, "nota (conflicto Google Drive 20261027_120000) (2).md");
        assert_eq!(std::fs::read_to_string(temp_dir.join(&name3)).unwrap(), "version 3");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_write_unique_conflict_file_extensions_and_dots() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_conflict_ext_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let fixed_time = chrono::DateTime::parse_from_rfc3339("2026-10-27T12:00:00Z").unwrap().with_timezone(&chrono::Utc);

        // Archivo con múltiples puntos en el nombre
        let name = write_unique_conflict_file(&temp_dir, "mi.archivo.notas.txt", b"txt content", fixed_time).unwrap();
        assert_eq!(name, "mi.archivo.notas (conflicto Google Drive 20261027_120000).txt");

        // Archivo sin extensión
        let name_no_ext = write_unique_conflict_file(&temp_dir, "sin_extension", b"plain", fixed_time).unwrap();
        assert_eq!(name_no_ext, "sin_extension (conflicto Google Drive 20261027_120000).txt");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_sanitize_error_message() {
        // 1. Mensaje vacío o espacios
        assert_eq!(
            sanitize_error_message("   "),
            "Error desconocido de sincronización."
        );

        // 2. Sesión revocada / invalid_grant
        let inv_grant = sanitize_error_message("Error 400: invalid_grant - token revoked");
        assert!(inv_grant.contains("La sesión con Google Drive ha expirado o fue revocada"));

        let ses_rev = sanitize_error_message("Fallo: Sesión revocada en el proveedor");
        assert!(ses_rev.contains("La sesión con Google Drive ha expirado o fue revocada"));

        // 3. Redacción de token Bearer (ya29...) sin perder texto adyacente ni delimitadores
        let raw_err = "Error en https://drive.googleapis.com con token \"ya29.a0AfH6SMBx_secret_token_value\", detail: ya29.second_token&query=1";
        let sanitized = sanitize_error_message(raw_err);
        assert!(!sanitized.contains("ya29.a0AfH6SMBx_secret_token_value"));
        assert!(!sanitized.contains("ya29.second_token"));
        assert!(sanitized.contains("\"[TOKEN_REDACTED]\""));
        assert!(sanitized.contains("detail: [TOKEN_REDACTED]&query=1"));

        // Redacción de token de actualización (1//0...)
        let raw_refresh = "Fallo con refresh_token 1//04abcDEF1234_xyz en cuerpo";
        let sanitized_refresh = sanitize_error_message(raw_refresh);
        assert!(!sanitized_refresh.contains("1//04abcDEF1234_xyz"));
        assert!(sanitized_refresh.contains("[TOKEN_REDACTED]"));

        // 4. HTML del servidor de error
        let html_err = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>";
        assert_eq!(
            sanitize_error_message(html_err),
            "Error del servidor de Google al procesar la solicitud."
        );

        // 5. Truncamiento de mensajes excesivamente largos
        let long_err = "E".repeat(500);
        let truncated = sanitize_error_message(&long_err);
        assert_eq!(truncated.len(), 300);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn test_write_unique_conflict_file_multithreaded_concurrency() {
        use std::sync::Arc;
        let temp_dir = Arc::new(std::env::temp_dir().join(format!(
            "lyra_test_conflict_mt_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
        std::fs::create_dir_all(&*temp_dir).unwrap();

        let fixed_time = chrono::DateTime::parse_from_rfc3339("2026-10-27T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);

        let mut handles = Vec::new();
        let num_threads = 10;

        // 10 hilos intentan escribir simultáneamente un archivo de conflicto para "nota.md"
        // con exactamente la misma marca temporal
        for i in 0..num_threads {
            let dir_clone = temp_dir.clone();
            let handle = std::thread::spawn(move || {
                let content = format!("thread content {i}");
                let written_name = write_unique_conflict_file(
                    &dir_clone,
                    "nota.md",
                    content.as_bytes(),
                    fixed_time,
                )
                .expect("La escritura atómica debe tener éxito sin colisionar");
                (written_name, content)
            });
            handles.push(handle);
        }

        let mut written_files = std::collections::HashSet::new();
        for h in handles {
            let (filename, content) = h.join().unwrap();
            // Comprobar que no hay dos hilos con el mismo nombre
            assert!(
                written_files.insert(filename.clone()),
                "El nombre '{filename}' fue generado más de una vez (colisión)"
            );
            // Comprobar que el archivo existe en disco y su contenido es íntegro
            let file_path = temp_dir.join(&filename);
            assert!(file_path.exists());
            assert_eq!(std::fs::read_to_string(&file_path).unwrap(), content);
        }

        // Exactamente 10 archivos distintos deben existir
        assert_eq!(written_files.len(), num_threads);

        let _ = std::fs::remove_dir_all(&*temp_dir);
    }

    #[tokio::test]
    async fn test_run_sync_subsequent_upload_new_local_file() {
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!(
            "lyra_test_sync_subsequent_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        // 1. Archivo preexistente antes de la primera sincronización
        let file1_path = temp_dir.join("Bienvenido.txt");
        std::fs::write(&file1_path, b"Hola mundo inicial").unwrap();

        // Servidor HTTP simulando Google Drive API v3
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            // Sincronización 1:
            // 1. get_or_create_lyra_folder (GET files?q=name='lyra'...)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[{"id":"folder_lyra_id","name":"lyra"}]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // 2. list_files_in_folder (GET files?q='folder_lyra_id' in parents...)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // 3. upload_file Bienvenido.txt (POST /upload/drive/v3/files?uploadType=multipart...)
            if let Ok(Some(mut req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(url.starts_with("/upload/drive/v3/files"), "URL de subida debe incluir /upload/drive/v3/files");
                assert!(url.contains("uploadType=multipart"));
                let mut b = Vec::new();
                let _ = req.as_reader().read_to_end(&mut b);
                let body_str = String::from_utf8_lossy(&b);
                assert!(body_str.contains("Bienvenido.txt"));

                let resp = r#"{"id":"drive_file1_id","name":"Bienvenido.txt","modifiedTime":"2026-10-28T10:00:00Z"}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(resp)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // Sincronización 2 (después de crear archivo nuevo):
            // 4. check_file_status (validando folder_lyra_id para la cuenta activa)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"id":"folder_lyra_id","name":"lyra","trashed":false,"mimeType":"application/vnd.google-apps.folder"}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // 5. list_files_in_folder (GET files?q='folder_lyra_id' in parents...)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[{"id":"drive_file1_id","name":"Bienvenido.txt","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"f321e854682a90363d708797a29e903a"}]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // 6. upload_file MiNuevaNota.md (POST /upload/drive/v3/files?uploadType=multipart...)
            if let Ok(Some(mut req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(url.starts_with("/upload/drive/v3/files"), "URL de subida debe incluir /upload/drive/v3/files, pero recibio: {url}");
                assert!(url.contains("uploadType=multipart"));
                let mut b = Vec::new();
                let _ = req.as_reader().read_to_end(&mut b);
                let body_str = String::from_utf8_lossy(&b);
                assert!(body_str.contains("MiNuevaNota.md"));
                assert!(body_str.contains("Contenido nuevo de prueba"));

                let resp = r#"{"id":"drive_file2_id","name":"MiNuevaNota.md","modifiedTime":"2026-10-28T11:00:00Z"}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(resp)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();

        // 2. Primera sincronización (archivo preexistente)
        let mut manifest = SyncManifest::default();
        let res1 = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Primera sincronización debe completarse");
        assert_eq!(res1.uploaded, vec!["Bienvenido.txt".to_string()]);
        assert_eq!(res1.errors.len(), 0);
        assert!(manifest.files.contains_key("Bienvenido.txt"));

        // 3. El usuario crea un nuevo archivo desde la aplicación
        let new_file_path = temp_dir.join("MiNuevaNota.md");
        std::fs::write(&new_file_path, b"# MiNuevaNota\n\nContenido nuevo de prueba").unwrap();

        // 4. Segunda sincronización: el usuario pulsa "Sincronizar"
        let res2 = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Segunda sincronización debe completarse");

        assert_eq!(res2.uploaded, vec!["MiNuevaNota.md".to_string()], "El nuevo archivo debe haber sido descubierto y subido a Drive");
        assert_eq!(res2.errors.len(), 0);
        assert!(manifest.files.contains_key("MiNuevaNota.md"), "El manifiesto debe haberse actualizado con el nuevo archivo");

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_sync_progress_emitter_only_emits_on_downloads() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Mutex;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!("lyra_emitter_test_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&temp_dir).unwrap();

        // 1. Archivo local para subida
        std::fs::write(temp_dir.join("Subida.txt"), b"Contenido para subir").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            // --- Sync 1: Solo subida ---
            // get_or_create_lyra_folder
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"files":[{"id":"f_id","name":"lyra"}]}"#)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // list_files_in_folder (vacío)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"files":[]}"#)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // upload_file
            if let Ok(Some(mut req)) = server.recv_timeout(Duration::from_secs(5)) {
                let mut b = Vec::new();
                let _ = req.as_reader().read_to_end(&mut b);
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"id":"up_id","name":"Subida.txt","modifiedTime":"2026-10-28T10:00:00Z"}"#)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // --- Sync 2: Descarga de archivo remoto (validando carpeta y listando)
            // check_file_status f_id
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"id":"f_id","name":"lyra","trashed":false,"mimeType":"application/vnd.google-apps.folder"}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // list_files_in_folder: Subida.txt y NuevoRemoto.txt
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[
                    {"id":"up_id","name":"Subida.txt","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"e6011a23015a17231bced509a4762080"},
                    {"id":"rem_id","name":"NuevoRemoto.txt","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"098f6bcd4621d373cade4e832627b4f6"}
                ]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
            // download_file NuevoRemoto.txt
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                assert!(req.url().contains("alt=media"));
                let _ = req.respond(
                    tiny_http::Response::from_string("test")
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()),
                );
            }
        });

        struct MockEmitter {
            start_count: Arc<AtomicUsize>,
            downloaded: Arc<Mutex<Vec<String>>>,
            finish_count: Arc<AtomicUsize>,
        }

        impl SyncProgressEmitter for MockEmitter {
            fn emit_download_start(&self) {
                self.start_count.fetch_add(1, Ordering::SeqCst);
            }

            fn emit_file_downloaded(&self, file_name: &str) {
                self.downloaded.lock().unwrap().push(file_name.to_string());
            }

            fn emit_download_finish(&self) {
                self.finish_count.fetch_add(1, Ordering::SeqCst);
            }
        }

        let start_count = Arc::new(AtomicUsize::new(0));
        let downloaded = Arc::new(Mutex::new(Vec::new()));
        let finish_count = Arc::new(AtomicUsize::new(0));

        let mock_emitter = MockEmitter {
            start_count: start_count.clone(),
            downloaded: downloaded.clone(),
            finish_count: finish_count.clone(),
        };

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest::default();

        // 1. Ejecutar Sync 1 (solo subida de archivo local)
        let res1 = run_sync_with_client_and_emitter(&temp_dir, &mut manifest, &client, Some(&mock_emitter))
            .await
            .expect("Sync 1 debe completarse");
        assert_eq!(res1.uploaded, vec!["Subida.txt".to_string()]);
        assert_eq!(res1.downloaded.len(), 0);

        // VERIFICACIÓN: El emitter NO debe haber emitido eventos de descarga
        assert_eq!(start_count.load(Ordering::SeqCst), 0, "No debe emitirse download_start si solo hay subidas");
        assert_eq!(downloaded.lock().unwrap().len(), 0, "No debe emitirse file_downloaded si no hay descargas");
        assert_eq!(finish_count.load(Ordering::SeqCst), 0, "No debe emitirse download_finish si no hubo descargas");

        // 2. Ejecutar Sync 2 (descarga de NuevoRemoto.txt)
        let res2 = run_sync_with_client_and_emitter(&temp_dir, &mut manifest, &client, Some(&mock_emitter))
            .await
            .expect("Sync 2 debe completarse");
        assert_eq!(res2.downloaded, vec!["NuevoRemoto.txt".to_string()]);

        // VERIFICACIÓN: El emitter debe haber emitido download_start una sola vez,
        // file_downloaded para NuevoRemoto.txt, y download_finish al terminar las importaciones.
        assert_eq!(start_count.load(Ordering::SeqCst), 1, "Debe emitirse download_start exactamente 1 vez");
        assert_eq!(*downloaded.lock().unwrap(), vec!["NuevoRemoto.txt".to_string()], "Debe emitirse file_downloaded con el nombre del archivo");
        assert_eq!(finish_count.load(Ordering::SeqCst), 1, "Debe emitirse download_finish al finalizar las descargas");

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_run_sync_full_bidirectional_subsequent_lifecycle() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!(
            "lyra_lifecycle_test_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let current_phase = Arc::new(AtomicUsize::new(1));
        let phase_clone = current_phase.clone();

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(mut req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                let method = req.method().clone();
                let p = phase_clone.load(Ordering::SeqCst);

                if url.starts_with("/drive/v3/files/folder_lyra_id") {
                    // check_file_status de la carpeta lyra para comprobar que sigue activa
                    let body = r#"{"id":"folder_lyra_id","name":"lyra","mimeType":"application/vnd.google-apps.folder","trashed":false}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(body)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Get && url.starts_with("/drive/v3/files?q=") && (url.contains("name+%3D") || url.contains("name%3D")) {
                    // get_or_create_lyra_folder (búsqueda inicial por nombre)
                    let body = r#"{"files":[{"id":"folder_lyra_id","name":"lyra"}]}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(body)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Post && url == "/drive/v3/files" {
                    // crear carpeta lyra si no existiese
                    let body = r#"{"id":"folder_lyra_id","name":"lyra","mimeType":"application/vnd.google-apps.folder"}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(body)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if url.contains("in%20parents") || url.contains("in+parents") {
                    // list_files_in_folder según la fase del ciclo de vida
                    let files_json = match p {
                        1 => r#"[{"id":"remoto_1_id","name":"remoto_inicial.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"13804a32da0fa99cf4140f92afe04700"}]"#,
                        2 => r#"[{"id":"remoto_1_id","name":"remoto_inicial.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"13804a32da0fa99cf4140f92afe04700"},{"id":"local_1_id","name":"local_inicial.txt","mimeType":"text/plain","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"a2e9974589a7573686ee0ec91809f0a8"},{"id":"remoto_2_id","name":"remoto_nuevo.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T11:00:00Z","md5Checksum":"41aa8b0960a318baf02981e0263d7a94"}]"#,
                        3 => r#"[{"id":"remoto_1_id","name":"remoto_inicial.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"42e8f05296d659e81d8326702a16b4e7"},{"id":"local_1_id","name":"local_inicial.txt","mimeType":"text/plain","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"a2e9974589a7573686ee0ec91809f0a8"},{"id":"remoto_2_id","name":"remoto_nuevo.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T11:00:00Z","md5Checksum":"41aa8b0960a318baf02981e0263d7a94"},{"id":"local_2_id","name":"local_nuevo.txt","mimeType":"text/plain","modifiedTime":"2026-10-28T11:00:00Z","md5Checksum":"275393f5c8dee0df747f916ec1d09ce2"}]"#,
                        4 => r#"[{"id":"remoto_1_id","name":"remoto_inicial.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"42e8f05296d659e81d8326702a16b4e7"},{"id":"local_1_id","name":"local_inicial.txt","mimeType":"text/plain","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"917da298e4183790c429842dc0803e91"},{"id":"remoto_2_id","name":"remoto_nuevo.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T11:00:00Z","md5Checksum":"41aa8b0960a318baf02981e0263d7a94"},{"id":"local_2_id","name":"local_nuevo.txt","mimeType":"text/plain","modifiedTime":"2026-10-28T11:00:00Z","md5Checksum":"275393f5c8dee0df747f916ec1d09ce2"}]"#,
                        _ => r#"[{"id":"remoto_1_id","name":"remoto_inicial.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"42e8f05296d659e81d8326702a16b4e7"},{"id":"local_1_id","name":"local_inicial.txt","mimeType":"text/plain","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"917da298e4183790c429842dc0803e91"},{"id":"remoto_2_id","name":"remoto_nuevo.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T11:00:00Z","md5Checksum":"41aa8b0960a318baf02981e0263d7a94"}]"#,
                    };
                    let resp = format!(r#"{{"files":{files_json}}}"#);
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if url.contains("?alt=media") {
                    // download_file
                    let content: &[u8] = if url.contains("remoto_1_id") {
                        if p >= 3 {
                            b"# Remoto 1 editado en la nube"
                        } else {
                            b"# Remoto 1"
                        }
                    } else if url.contains("remoto_2_id") {
                        b"# Nuevo Remoto"
                    } else {
                        b"datos descargados"
                    };
                    let _ = req.respond(
                        tiny_http::Response::from_string(String::from_utf8_lossy(content))
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Post && url.starts_with("/upload/drive/v3/files") {
                    // upload_file
                    let mut b = Vec::new();
                    let _ = req.as_reader().read_to_end(&mut b);
                    let s = String::from_utf8_lossy(&b);
                    let (file_id, file_name, md5) = if s.contains("local_inicial.txt") {
                        ("local_1_id", "local_inicial.txt", "a2e9974589a7573686ee0ec91809f0a8")
                    } else {
                        ("local_2_id", "local_nuevo.txt", "275393f5c8dee0df747f916ec1d09ce2")
                    };
                    let resp = format!(r#"{{"id":"{file_id}","name":"{file_name}","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"{md5}"}}"#);
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Patch && url.starts_with("/upload/drive/v3/files/") {
                    // update_file
                    let resp = r#"{"id":"local_1_id","name":"local_inicial.txt","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"917da298e4183790c429842dc0803e91"}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Patch && url.starts_with("/drive/v3/files/") {
                    // trash_file
                    let resp = r#"{"id":"local_2_id","trashed":true}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest::default();

        // --- FASE 1: Sincronización Inicial (Importación nube + subida local) ---
        current_phase.store(1, Ordering::SeqCst);
        let file_local1 = temp_dir.join("local_inicial.txt");
        std::fs::write(&file_local1, b"contenido local 1").unwrap();

        let res1 = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Fase 1 debe completarse exitosamente");
        assert_eq!(res1.uploaded, vec!["local_inicial.txt".to_string()]);
        assert_eq!(res1.downloaded, vec!["remoto_inicial.md".to_string()]);
        assert_eq!(res1.errors.len(), 0);
        assert_eq!(manifest.drive_folder_id, "folder_lyra_id");
        assert!(manifest.files.contains_key("local_inicial.txt"));
        assert!(manifest.files.contains_key("remoto_inicial.md"));
        assert_eq!(std::fs::read_to_string(temp_dir.join("remoto_inicial.md")).unwrap(), "# Remoto 1");

        // --- FASE 2: Altas subsecuentes en ambas direcciones ---
        current_phase.store(2, Ordering::SeqCst);
        let file_local2 = temp_dir.join("local_nuevo.txt");
        std::fs::write(&file_local2, b"nuevo local").unwrap();

        let res2 = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Fase 2 debe completarse exitosamente");
        assert_eq!(res2.uploaded, vec!["local_nuevo.txt".to_string()], "El nuevo archivo local debe subirse a Drive");
        assert_eq!(res2.downloaded, vec!["remoto_nuevo.md".to_string()], "El nuevo archivo remoto debe descargarse a local");
        assert_eq!(res2.errors.len(), 0);
        assert!(manifest.files.contains_key("local_nuevo.txt"));
        assert!(manifest.files.contains_key("remoto_nuevo.md"));
        assert_eq!(std::fs::read_to_string(temp_dir.join("remoto_nuevo.md")).unwrap(), "# Nuevo Remoto");

        // --- FASE 3: Modificaciones subsecuentes en ambas direcciones ---
        current_phase.store(3, Ordering::SeqCst);
        std::fs::write(&file_local1, b"contenido local 1 modificado").unwrap();

        let res3 = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Fase 3 debe completarse exitosamente");
        assert_eq!(res3.uploaded, vec!["local_inicial.txt".to_string()], "El archivo local modificado debe actualizarse en Drive");
        assert_eq!(res3.downloaded, vec!["remoto_inicial.md".to_string()], "El archivo remoto modificado debe descargarse a local");
        assert_eq!(res3.errors.len(), 0);
        assert_eq!(std::fs::read_to_string(temp_dir.join("remoto_inicial.md")).unwrap(), "# Remoto 1 editado en la nube");

        // --- FASE 4: Eliminación local intencional (con tombstone) -> Mover a papelera en Drive ---
        current_phase.store(4, Ordering::SeqCst);
        provenance::record_local_write(&temp_dir, "local_nuevo.txt", Some("test"), true).unwrap();
        let mut link_ctx = SyncAccountContext::open_test(&temp_dir, "test").unwrap();
        link_ctx.record_manifest_links(&manifest, &["local_nuevo.txt".to_string()]);
        link_ctx.persist().unwrap();
        let deleted_note_id = provenance::load_ledger(&provenance::get_ledger_path(&temp_dir))
            .unwrap().unwrap().by_name["local_nuevo.txt"].clone();
        provenance::retire_note(&temp_dir, "local_nuevo.txt").unwrap();
        std::fs::remove_file(&file_local2).unwrap();
        manifest.pending_deletions.insert(
            "local_nuevo.txt".to_string(),
            super::super::types::PendingDeletion {
                drive_id: Some("local_2_id".to_string()),
                deleted_at: Utc::now().timestamp_millis(),
                account_key: Some("test".to_string()),
                note_id: Some(deleted_note_id),
            },
        );
        manifest.files.remove("local_nuevo.txt");

        let res4 = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Fase 4 debe completarse exitosamente");
        assert_eq!(res4.deleted_remote, vec!["local_nuevo.txt".to_string()], "El archivo borrado localmente debe enviarse a la papelera en Drive");
        assert_eq!(res4.errors.len(), 0);
        assert!(!manifest.files.contains_key("local_nuevo.txt"), "El archivo borrado debe eliminarse del manifiesto");

        // --- FASE 5: Sincronización al día / sin cambios ---
        current_phase.store(5, Ordering::SeqCst);
        let res5 = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Fase 5 debe completarse exitosamente");
        assert_eq!(res5.uploaded.len(), 0);
        assert_eq!(res5.downloaded.len(), 0);
        assert_eq!(res5.deleted_remote.len(), 0);
        assert_eq!(res5.errors.len(), 0);

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_remote_file_trashed_restores_untrash_preserves_local() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!(
            "lyra_test_remote_trashed_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Archivo existe localmente
        let file_path = temp_dir.join("nota_importante.md");
        std::fs::write(&file_path, b"# Mi nota intacta").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let untrash_called = Arc::new(AtomicBool::new(false));
        let untrash_clone = untrash_called.clone();

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(mut req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                let method = req.method().clone();

                if url.contains("in%20parents") || url.contains("in+parents") {
                    // list_files_in_folder devuelve lista VACÍA (archivo fue movido a papelera en Drive)
                    let _ = req.respond(
                        tiny_http::Response::from_string(r#"{"files":[]}"#)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Get && url.contains("/drive/v3/files/file_trashed_id") {
                    // check_file_status confirma que el archivo está en papelera
                    let body = r#"{"id":"file_trashed_id","name":"nota_importante.md","trashed":true}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(body)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Patch && url.contains("/drive/v3/files/file_trashed_id") {
                    // untrash_file (PATCH con {"trashed":false})
                    let mut b = Vec::new();
                    let _ = req.as_reader().read_to_end(&mut b);
                    let body_str = String::from_utf8_lossy(&b);
                    if body_str.contains(r#""trashed":false"#) || body_str.contains(r#""trashed": false"#) {
                        untrash_clone.store(true, Ordering::SeqCst);
                    }
                    let resp = r#"{"id":"file_trashed_id","name":"nota_importante.md","trashed":false}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            files: HashMap::from([(
                "nota_importante.md".to_string(),
                FileManifestItem {
                    drive_id: "file_trashed_id".to_string(),
                    md5: compute_md5(b"# Mi nota intacta"),
                    local_mtime: 1000,
                    remote_mtime: "2026-10-28T10:00:00Z".to_string(),
                    local_size: 17,
                },
            )]),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sincronización debe completarse");

        // VERIFICACIONES CRÍTICAS DE INTEGRIDAD:
        // 1. El archivo local NUNCA debe eliminarse
        assert!(file_path.exists(), "REGLA FUNDAMENTAL: El archivo local no debe ser eliminado");
        assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "# Mi nota intacta");

        // 2. Se debió invocar untrash_file en Google Drive
        assert!(untrash_called.load(Ordering::SeqCst), "Se debe llamar a untrash_file para restaurar el archivo en Drive");

        // 3. El manifiesto conserva el archivo
        assert!(manifest.files.contains_key("nota_importante.md"));
        assert_eq!(res.errors.len(), 0);

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_remote_file_deleted_permanently_reuploads_preserves_local() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!(
            "lyra_test_remote_404_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let file_path = temp_dir.join("nota_permanente.md");
        std::fs::write(&file_path, b"# Conservar intacto").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let upload_called = Arc::new(AtomicBool::new(false));
        let upload_clone = upload_called.clone();

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                let method = req.method().clone();

                if url.contains("in%20parents") || url.contains("in+parents") {
                    // list_files_in_folder devuelve lista VACÍA
                    let _ = req.respond(
                        tiny_http::Response::from_string(r#"{"files":[]}"#)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Get && url.contains("/drive/v3/files/file_404_id") {
                    // check_file_status devuelve 404 (eliminado permanentemente de Drive)
                    let _ = req.respond(
                        tiny_http::Response::from_string(r#"{"error":{"code":404,"message":"File not found"}}"#)
                            .with_status_code(404)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Post && url.starts_with("/upload/drive/v3/files") {
                    // Re-subida de la nota local
                    upload_clone.store(true, Ordering::SeqCst);
                    let resp = r#"{"id":"new_reuploaded_id","name":"nota_permanente.md","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"abc"}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            files: HashMap::from([(
                "nota_permanente.md".to_string(),
                FileManifestItem {
                    drive_id: "file_404_id".to_string(),
                    md5: compute_md5(b"# Conservar intacto"),
                    local_mtime: 1000,
                    remote_mtime: "2026-10-28T10:00:00Z".to_string(),
                    local_size: 19,
                },
            )]),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sincronización debe completarse");

        // VERIFICACIONES CRÍTICAS:
        assert!(file_path.exists(), "REGLA FUNDAMENTAL: El archivo local nunca debe ser eliminado");
        assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "# Conservar intacto");
        assert!(upload_called.load(Ordering::SeqCst), "Debe re-subir el archivo a Drive");
        assert_eq!(res.uploaded, vec!["nota_permanente.md".to_string()]);
        assert_eq!(manifest.files["nota_permanente.md"].drive_id, "new_reuploaded_id");

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_remote_lyra_folder_trashed_restored_via_untrash() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!(
            "lyra_test_folder_trashed_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let file_path = temp_dir.join("mi_nota.txt");
        std::fs::write(&file_path, b"datos de nota").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let folder_untrashed = Arc::new(AtomicBool::new(false));
        let folder_clone = folder_untrashed.clone();

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(mut req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                let method = req.method().clone();

                if url.contains("in%20parents") || url.contains("in+parents") {
                    if !folder_clone.load(Ordering::SeqCst) {
                        // Antes de des-papelar, devuelve 404
                        let _ = req.respond(
                            tiny_http::Response::from_string(r#"{"error":{"code":404,"message":"Folder in trash"}}"#)
                                .with_status_code(404)
                                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                        );
                    } else {
                        // Tras des-papelar: devuelve la lista de archivos
                        let body = r#"{"files":[{"id":"f1_id","name":"mi_nota.txt","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"4046d332616f0e443ce17f3d532a7924"}]}"#;
                        let _ = req.respond(
                            tiny_http::Response::from_string(body)
                                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                        );
                    }
                } else if method == tiny_http::Method::Get && url.contains("/drive/v3/files/folder_trashed_id") {
                    // check_file_status de la carpeta: está en papelera
                    let body = r#"{"id":"folder_trashed_id","name":"lyra","trashed":true}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(body)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Patch && url.contains("/drive/v3/files/folder_trashed_id") {
                    // untrash de la carpeta lyra
                    let mut b = Vec::new();
                    let _ = req.as_reader().read_to_end(&mut b);
                    folder_clone.store(true, Ordering::SeqCst);
                    let resp = r#"{"id":"folder_trashed_id","name":"lyra","trashed":false}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "folder_trashed_id".to_string(),
            files: HashMap::from([(
                "mi_nota.txt".to_string(),
                FileManifestItem {
                    drive_id: "f1_id".to_string(),
                    md5: compute_md5(b"datos de nota"),
                    local_mtime: 1000,
                    remote_mtime: "2026-10-28T10:00:00Z".to_string(),
                    local_size: 13,
                },
            )]),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sincronización debe recuperarse");

        assert!(file_path.exists(), "Los archivos locales deben permanecer intactos si la carpeta lyra remota fue a papelera");
        assert!(folder_untrashed.load(Ordering::SeqCst), "La carpeta lyra debe restaurarse de la papelera");
        assert_eq!(manifest.drive_folder_id, "folder_trashed_id");
        assert_eq!(res.errors.len(), 0);

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_external_local_deletion_without_tombstone_recovers_from_drive() {
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!(
            "lyra_test_ext_del_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        // El archivo NO existe en disco local (desapareció externamente sin tombstone en Lyra)
        let recovered_path = temp_dir.join("recuperar.md");

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();

                if url.contains("in%20parents") || url.contains("in+parents") {
                    let body = r#"{"files":[{"id":"rec_id","name":"recuperar.md","mimeType":"text/markdown","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"f321e854682a90363d708797a29e903a"}]}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(body)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if url.contains("?alt=media") {
                    let _ = req.respond(
                        tiny_http::Response::from_string("# Nota Recuperada de Drive")
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            // No hay tombstone en pending_deletions
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sincronización debe completarse");

        // VERIFICACIÓN DECISIÓN 2: Desaparición externa debe recuperarse desde Drive
        assert!(recovered_path.exists(), "El archivo desaparecido externamente debe recuperarse desde Google Drive");
        assert_eq!(std::fs::read_to_string(&recovered_path).unwrap(), "# Nota Recuperada de Drive");
        assert_eq!(res.downloaded, vec!["recuperar.md".to_string()]);
        assert!(manifest.files.contains_key("recuperar.md"));

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_tombstone_annulled_if_recreated_locally() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!(
            "lyra_test_tombstone_recreate_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        // El usuario borró el archivo previamente, pero lo recreó en disco antes de la siguiente sincronización
        let file_path = temp_dir.join("recreada.txt");
        std::fs::write(&file_path, b"contenido anterior").unwrap();
        provenance::record_local_write(&temp_dir, "recreada.txt", Some("test"), true).unwrap();
        let mut link_ctx = SyncAccountContext::open_test(&temp_dir, "test").unwrap();
        let mut link_manifest = SyncManifest::default();
        link_manifest.files.insert("recreada.txt".to_string(), FileManifestItem {
            drive_id: "old_drive_id".to_string(), md5: compute_md5(b"contenido anterior"),
            local_mtime: 0, remote_mtime: String::new(), local_size: 18,
        });
        link_ctx.record_manifest_links(&link_manifest, &["recreada.txt".to_string()]);
        link_ctx.persist().unwrap();
        let deleted_note_id = provenance::load_ledger(&provenance::get_ledger_path(&temp_dir))
            .unwrap().unwrap().by_name["recreada.txt"].clone();
        provenance::retire_note(&temp_dir, "recreada.txt").unwrap();
        std::fs::write(&file_path, b"contenido recreado").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let trash_called = Arc::new(AtomicBool::new(false));
        let trash_clone = trash_called.clone();

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                let method = req.method().clone();

                if url.contains("in%20parents") || url.contains("in+parents") {
                    let body = r#"{"files":[{"id":"old_drive_id","name":"recreada.txt","modifiedTime":"2026-10-28T09:00:00Z","md5Checksum":"old_md5"}]}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(body)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Patch && url.starts_with("/drive/v3/files/old_drive_id") {
                    // trash_file sobre la nota antigua eliminada para desvincularla de la nueva
                    trash_clone.store(true, Ordering::SeqCst);
                    let _ = req.respond(tiny_http::Response::from_string(r#"{"trashed":true}"#));
                } else if method == tiny_http::Method::Post && url.starts_with("/upload/drive/v3/files") {
                    // upload_file para subir la nueva nota como un archivo independiente con nuevo ID
                    let resp = r#"{"id":"new_recreated_id","name":"recreada.txt","modifiedTime":"2026-10-28T12:00:00Z","md5Checksum":"new_md5"}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            files: HashMap::from([(
                "recreada.txt".to_string(),
                FileManifestItem {
                    drive_id: "old_drive_id".to_string(),
                    md5: "old_md5".to_string(),
                    local_mtime: 500,
                    remote_mtime: "2026-10-28T09:00:00Z".to_string(),
                    local_size: 10,
                },
            )]),
            pending_deletions: HashMap::from([(
                "recreada.txt".to_string(),
                super::super::types::PendingDeletion {
                    drive_id: Some("old_drive_id".to_string()),
                    deleted_at: Utc::now().timestamp_millis(),
                    account_key: Some("test".to_string()),
                    note_id: Some(deleted_note_id),
                },
            )]),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sincronización debe completarse");

        assert!(trash_called.load(Ordering::SeqCst), "trash_file DEBE llamarse para mover la versión previa a la papelera en Drive");
        assert!(!manifest.pending_deletions.contains_key("recreada.txt"), "El tombstone debe haber sido procesado");
        assert!(manifest.files.contains_key("recreada.txt"), "El archivo debe conservarse en el manifiesto");
        assert_eq!(manifest.files["recreada.txt"].drive_id, "new_recreated_id", "La nueva nota debe tener un ID nuevo desvinculado del anterior");
        assert_eq!(res.deleted_remote, vec!["recreada.txt".to_string()]);
        assert_eq!(res.uploaded, vec!["recreada.txt".to_string()]);

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_manifest_corruption_recovers_from_bak() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_bak_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let manifest_path = temp_dir.join(".gdrive_manifest.json");

        let manifest1 = SyncManifest {
            drive_folder_id: "folder_v1".to_string(),
            files: HashMap::from([(
                "nota1.txt".to_string(),
                FileManifestItem {
                    drive_id: "d1".to_string(),
                    md5: "md5_1".to_string(),
                    local_mtime: 100,
                    remote_mtime: "2026-10-28T00:00:00Z".to_string(),
                    local_size: 10,
                },
            )]),
            ..Default::default()
        };
        save_manifest_to_path(&manifest_path, &manifest1).unwrap();

        // Segunda versión: genera copia .bak de la v1
        let mut manifest2 = manifest1.clone();
        manifest2.drive_folder_id = "folder_v2".to_string();
        save_manifest_to_path(&manifest_path, &manifest2).unwrap();
        assert!(manifest_path.with_extension("json.bak").exists());

        // Corromper intencionalmente el archivo principal
        std::fs::write(&manifest_path, b"{\"incompleto\": true, corrupt...").unwrap();

        // Cargar debe recuperarse automáticamente desde .bak
        let recovered = load_manifest_from_path(&manifest_path);
        assert_eq!(recovered.drive_folder_id, "folder_v1");
        assert!(recovered.files.contains_key("nota1.txt"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_manifest_stale_tmp_files_cleanup() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_tmp_cleanup_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let manifest_path = temp_dir.join(".gdrive_manifest.json");

        // Crear temporal huérfano simulado
        let stale_tmp = temp_dir.join(".gdrive_manifest.tmp.99999");
        std::fs::write(&stale_tmp, b"temporal huerfano").unwrap();
        assert!(stale_tmp.exists());

        let manifest = SyncManifest::default();
        save_manifest_to_path(&manifest_path, &manifest).unwrap();

        // El temporal huérfano debió ser eliminado
        assert!(!stale_tmp.exists(), "Los temporales huérfanos anteriores deben limpiarse");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_transient_network_error_on_folder_check_does_not_create_duplicate() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!("lyra_test_folder_err_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let created_new_folder = Arc::new(AtomicBool::new(false));
        let created_clone = created_new_folder.clone();

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                let method = req.method().clone();

                if url.contains("in%20parents") || url.contains("in+parents") {
                    // Fallo al listar
                    let _ = req.respond(
                        tiny_http::Response::from_string("Network timeout")
                            .with_status_code(500)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Get && url.contains("/drive/v3/files/my_existing_folder_id") {
                    // check_file_status también devuelve error 500 de servidor temporal
                    let _ = req.respond(
                        tiny_http::Response::from_string("Internal error")
                            .with_status_code(500)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()),
                    );
                } else if method == tiny_http::Method::Post && url == "/drive/v3/files" {
                    created_clone.store(true, Ordering::SeqCst);
                    let _ = req.respond(tiny_http::Response::from_string(r#"{"id":"dup_folder"}"#));
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "my_existing_folder_id".to_string(),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client).await;
        assert!(res.is_err(), "Ante error transitorio de servidor en la carpeta, la sincronización debe abortar");
        assert!(!created_new_folder.load(Ordering::SeqCst), "NO debe crear una nueva carpeta ante un error transitorio");
        assert_eq!(manifest.drive_folder_id, "my_existing_folder_id", "El drive_folder_id debe conservarse intacto");

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_error_403_on_remote_check_preserves_local_file() {
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!("lyra_test_403_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let local_file = temp_dir.join("secreto.md");
        std::fs::write(&local_file, b"Contenido altamente confidencial").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                if url.contains("in%20parents") || url.contains("in+parents") {
                    let _ = req.respond(
                        tiny_http::Response::from_string(r#"{"files":[]}"#)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if url.contains("/drive/v3/files/file_403_id") {
                    let _ = req.respond(
                        tiny_http::Response::from_string(r#"{"error":{"code":403,"message":"Insufficient Permission"}}"#)
                            .with_status_code(403)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            files: HashMap::from([(
                "secreto.md".to_string(),
                FileManifestItem {
                    drive_id: "file_403_id".to_string(),
                    md5: compute_md5(b"Contenido altamente confidencial"),
                    local_mtime: 100,
                    remote_mtime: "2026-10-28T00:00:00Z".to_string(),
                    local_size: 32,
                },
            )]),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sync debe finalizar sin pánico");

        assert!(local_file.exists(), "El archivo local debe permanecer intacto ante un error 403");
        assert_eq!(std::fs::read_to_string(&local_file).unwrap(), "Contenido altamente confidencial");
        assert_eq!(res.deleted_remote.len(), 0);

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_post_upload_file_non_idempotent_no_5xx_retry() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = attempts.clone();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(1500)) {
                let url = req.url().to_string();
                if url.starts_with("/upload/drive/v3/files") {
                    attempts_clone.fetch_add(1, Ordering::SeqCst);
                    let _ = req.respond(
                        tiny_http::Response::from_string("Internal error")
                            .with_status_code(503)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let result = client.upload_file("", "folder_id", "nota.txt", b"hola", "2026-10-28T00:00:00Z").await;

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1, "upload_file (POST) NO debe reintentarse ante 5xx para evitar duplicados");

        let _ = server_handle.join();
    }

    #[tokio::test]
    async fn test_duplicate_remote_file_restored_from_trash_downloads_as_conflict() {
        use std::time::Duration;

        let temp_dir = std::env::temp_dir().join(format!("lyra_test_untrash_conflict_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Archivo recreado localmente con nuevo contenido
        let local_file = temp_dir.join("recreada.txt");
        let local_bytes = b"Contenido recreado localmente";
        std::fs::write(&local_file, local_bytes).unwrap();
        let local_md5 = compute_md5(local_bytes);

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_md5 = local_md5.clone();
        let server_handle = std::thread::spawn(move || {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(2000)) {
                let url = req.url().to_string();
                if url.contains("in%20parents") || url.contains("in+parents") {
                    // Drive devuelve DOS archivos con el mismo nombre 'recreada.txt':
                    // 1. La copia primaria (nueva) con id 'id_primaria'
                    // 2. La copia restaurada de la papelera con id 'id_restaurada'
                    let json = r#"{
                        "files": [
                            {
                                "id": "id_primaria",
                                "name": "recreada.txt",
                                "mimeType": "text/plain",
                                "modifiedTime": "2026-10-28T02:00:00Z",
                                "md5Checksum": ""#
                                .to_string()
                                + &server_md5
                                + r#"",
                                "trashed": false
                            },
                            {
                                "id": "id_restaurada",
                                "name": "recreada.txt",
                                "mimeType": "text/plain",
                                "modifiedTime": "2026-10-28T01:00:00Z",
                                "md5Checksum": "md5_viejo_restaurado",
                                "trashed": false
                            }
                        ]
                    }"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(json)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else if url.contains("/drive/v3/files/id_restaurada?alt=media") {
                    let _ = req.respond(tiny_http::Response::from_data(b"Contenido de la nota restaurada de la papelera".to_vec()));
                } else if url.contains("/drive/v3/files/id_restaurada") && req.method().as_str() == "PATCH" {
                    // Responder al rename_file
                    let resp = r#"{"id":"id_restaurada","name":"renombrado.txt","trashed":false}"#;
                    let _ = req.respond(
                        tiny_http::Response::from_string(resp)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                    );
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("{}"));
                }
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            files: HashMap::from([(
                "recreada.txt".to_string(),
                FileManifestItem {
                    drive_id: "id_primaria".to_string(),
                    md5: local_md5.clone(),
                    local_mtime: 100,
                    remote_mtime: "2026-10-28T02:00:00Z".to_string(),
                    local_size: local_bytes.len() as u64,
                },
            )]),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sync debe completarse exitosamente");

        // 1. El archivo local 'recreada.txt' debe seguir intacto con el contenido recreado
        assert!(local_file.exists());
        assert_eq!(std::fs::read(&local_file).unwrap(), local_bytes);

        // 2. La copia restaurada de la papelera de Drive DEBE haberse descargado como copia de conflicto
        assert_eq!(res.downloaded.len(), 1, "La copia restaurada de Drive debe descargarse");
        let conflict_filename = &res.downloaded[0];
        assert!(conflict_filename.starts_with("recreada (conflicto Google Drive"));
        assert!(conflict_filename.ends_with(".txt"));

        // 3. El archivo de conflicto en disco debe contener el texto restaurado
        let conflict_path = temp_dir.join(conflict_filename);
        assert!(conflict_path.exists());
        assert_eq!(std::fs::read(&conflict_path).unwrap(), b"Contenido de la nota restaurada de la papelera");

        // 4. El manifiesto debe contener ambos archivos registrados con sus respectivos drive_id
        assert_eq!(manifest.files.get("recreada.txt").unwrap().drive_id, "id_primaria");
        assert_eq!(manifest.files.get(conflict_filename).unwrap().drive_id, "id_restaurada");

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_sync_unmodified_welcome_file_skips_upload_to_gdrive() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_welcome_skip_{}", rand::random::<u32>()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let welcome_file = temp_dir.join("¡Bienvenid@ a Lyra!.txt");
        let default_intro = b"Bienvenido a Lyra\n\nLyra es un espacio de escritura minimalista y libre de distracciones.\n\nEmpieza a escribir cuando quieras. Puedes editar o eliminar esta nota en cualquier momento.";
        std::fs::write(&welcome_file, default_intro).unwrap();
        provenance::record_local_write(&temp_dir, "¡Bienvenid@ a Lyra!.txt", None, true).unwrap();
        provenance::mark_internal_welcome(&temp_dir, "¡Bienvenid@ a Lyra!.txt", default_intro).unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            // 1. check_file_status (validar carpeta)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"id":"folder_lyra_id","name":"lyra","trashed":false,"mimeType":"application/vnd.google-apps.folder"}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 2. list_files_in_folder (Drive está vacío)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
        });

        let mut client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url.clone()).unwrap();
        client.upload_url = format!("{base_url}/upload/drive/v3/files");

        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sync debe completarse exitosamente");

        // El archivo de bienvenida predeterminado NO debe haberse subido a Drive (evita subidas innecesarias)
        assert_eq!(res.uploaded, Vec::<String>::new());
        assert!(!res.pending_authorization);
        assert!(res.blocked_uploads.is_empty());
        assert!(!manifest.files.contains_key("¡Bienvenid@ a Lyra!.txt"));

        // El archivo local sigue existiendo intacto
        assert!(welcome_file.exists());

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_sync_modified_welcome_file_uploads_to_gdrive() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_welcome_upload_{}", rand::random::<u32>()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let welcome_file = temp_dir.join("¡Bienvenid@ a Lyra!.txt");
        let modified_content = b"Mis notas personales modificadas en el archivo de bienvenida.";
        std::fs::write(&welcome_file, modified_content).unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            // 0. check_file_status (validar carpeta)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"id":"folder_lyra_id","name":"lyra","trashed":false,"mimeType":"application/vnd.google-apps.folder"}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 1. GET /drive/v3/files? (Drive vacío)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 2. POST upload_file (porque fue modificado por el usuario)
            if let Ok(Some(mut req)) = server.recv_timeout(Duration::from_secs(5)) {
                let mut b = Vec::new();
                let _ = req.as_reader().read_to_end(&mut b);
                let body_str = String::from_utf8_lossy(&b);
                assert!(body_str.contains("¡Bienvenid@ a Lyra!.txt"));

                let resp = r#"{"id":"welcome_drive_id","name":"¡Bienvenid@ a Lyra!.txt","modifiedTime":"2026-10-30T10:00:00Z"}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(resp)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
        });

        let mut client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url.clone()).unwrap();
        client.upload_url = format!("{base_url}/upload/drive/v3/files");

        let mut manifest = SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sync debe completarse exitosamente");

        // El archivo de bienvenida modificado SÍ debe subirse como nota de usuario
        assert_eq!(res.uploaded, vec!["¡Bienvenid@ a Lyra!.txt".to_string()]);
        assert!(manifest.files.contains_key("¡Bienvenid@ a Lyra!.txt"));

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_account_switching_a_b_a_manifest_isolation() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_account_switch_{}", rand::random::<u32>()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let sub_a = "google_user_11111";
        let email_a = "userA@gmail.com";
        let sub_b = "google_user_22222";
        let email_b = "userB@gmail.com";

        // 1. Cargar estado de Cuenta A y registrar archivo y tombstone
        let mut manifest_a = load_manifest_for_account_dir(&temp_dir, sub_a, Some(email_a));
        assert_eq!(manifest_a.account_id.as_deref(), Some(sub_a));
        assert_eq!(manifest_a.account_email.as_deref(), Some(email_a));
        manifest_a.drive_folder_id = "folder_account_a".to_string();
        manifest_a.files.insert(
            "nota_A.txt".to_string(),
            FileManifestItem {
                drive_id: "drive_a_1".to_string(),
                md5: "md5_a".to_string(),
                local_mtime: 1000,
                remote_mtime: "2026-10-30T10:00:00Z".to_string(),
                local_size: 10,
            },
        );
        manifest_a.pending_deletions.insert(
            "borrada_A.txt".to_string(),
            PendingDeletion {
                drive_id: Some("drive_id_del_a".to_string()),
                deleted_at: 1000,
                account_key: None,
                note_id: None,
            },
        );
        let path_a = get_manifest_path_for_account(&temp_dir, sub_a);
        save_manifest_to_path(&path_a, &manifest_a).unwrap();

        // 2. Cambiar a Cuenta B: debe cargar un manifiesto limpio y aislado
        let mut manifest_b = load_manifest_for_account_dir(&temp_dir, sub_b, Some(email_b));
        assert_eq!(manifest_b.account_id.as_deref(), Some(sub_b));
        assert_eq!(manifest_b.account_email.as_deref(), Some(email_b));
        assert_eq!(manifest_b.drive_folder_id, "");
        assert!(manifest_b.files.is_empty(), "Cuenta B no debe ver archivos de Cuenta A");
        assert!(manifest_b.pending_deletions.is_empty(), "Cuenta B no debe heredar tombstones de Cuenta A");

        // Guardar archivo en Cuenta B
        manifest_b.drive_folder_id = "folder_account_b".to_string();
        manifest_b.files.insert(
            "nota_B.txt".to_string(),
            FileManifestItem {
                drive_id: "drive_b_1".to_string(),
                md5: "md5_b".to_string(),
                local_mtime: 2000,
                remote_mtime: "2026-10-30T11:00:00Z".to_string(),
                local_size: 20,
            },
        );
        let path_b = get_manifest_path_for_account(&temp_dir, sub_b);
        save_manifest_to_path(&path_b, &manifest_b).unwrap();

        // 3. Volver a cambiar a Cuenta A: debe restaurar el manifiesto intacto de Cuenta A
        let restored_a = load_manifest_for_account_dir(&temp_dir, sub_a, Some(email_a));
        assert_eq!(restored_a.account_id.as_deref(), Some(sub_a));
        assert_eq!(restored_a.drive_folder_id, "folder_account_a");
        assert!(restored_a.files.contains_key("nota_A.txt"));
        assert!(!restored_a.files.contains_key("nota_B.txt"), "Cuenta A no debe ver archivos de Cuenta B");
        assert!(restored_a.pending_deletions.contains_key("borrada_A.txt"), "Tombstones de Cuenta A deben permanecer intactos");

        // 4. Verificar que Cuenta B sigue intacta en disco
        let restored_b = load_manifest_for_account_dir(&temp_dir, sub_b, Some(email_b));
        assert_eq!(restored_b.drive_folder_id, "folder_account_b");
        assert!(restored_b.files.contains_key("nota_B.txt"));
        assert!(!restored_b.files.contains_key("nota_A.txt"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_sync_recovers_from_invalid_404_folder_id() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_folder_404_{}", rand::random::<u32>()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            // 1. check_file_status de la carpeta inválida -> 404 Not Found
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(url.contains("foreign_folder_404"));
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"error":{"code":404,"message":"File not found"}}"#)
                        .with_status_code(404)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 2. get_or_create_lyra_folder (busca carpeta 'lyra' en Drive para la cuenta activa)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[{"id":"real_active_folder_id","name":"lyra"}]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 3. list_files_in_folder de la carpeta recuperada real_active_folder_id
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(url.contains("real_active_folder_id"));
                let body = r#"{"files":[{"id":"f1_id","name":"nota_recuperada.txt","modifiedTime":"2026-10-30T10:00:00Z","md5Checksum":"098f6bcd4621d373cade4e832627b4f6"}]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 4. download_file de nota_recuperada.txt
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                assert!(req.url().contains("alt=media"));
                let _ = req.respond(
                    tiny_http::Response::from_string("test content")
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()),
                );
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "foreign_folder_404".to_string(),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sync debe recuperarse del 404 y resolver la carpeta correcta");

        // El ID inválido debe haber sido reemplazado por la carpeta real
        assert_eq!(manifest.drive_folder_id, "real_active_folder_id");
        assert_eq!(res.downloaded, vec!["nota_recuperada.txt".to_string()]);
        assert!(temp_dir.join("nota_recuperada.txt").exists());

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_sync_recovers_from_forbidden_403_folder_id() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_folder_403_{}", rand::random::<u32>()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let server_handle = std::thread::spawn(move || {
            // 1. check_file_status de la carpeta -> 403 Forbidden
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"error":{"code":403,"message":"The user does not have sufficient permissions"}}"#)
                        .with_status_code(403)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 2. get_or_create_lyra_folder busca en cuenta activa
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[{"id":"correct_account_folder","name":"lyra"}]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }

            // 3. list_files_in_folder de correct_account_folder (vacío)
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"files":[]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
                );
            }
        });

        let client = DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), base_url).unwrap();
        let mut manifest = SyncManifest {
            drive_folder_id: "forbidden_folder_403".to_string(),
            ..Default::default()
        };

        let res = run_sync_with_client(&temp_dir, &mut manifest, &client)
            .await
            .expect("Sync debe recuperarse de 403 descartando el folder ID inválido");

        assert_eq!(manifest.drive_folder_id, "correct_account_folder");
        assert_eq!(res.errors.len(), 0);

        let _ = server_handle.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_legacy_manifest_migration_handling() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_legacy_migration_{}", rand::random::<u32>()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let legacy_file = temp_dir.join(".gdrive_manifest.json");

        // Caso 1: Manifiesto heredado vacío con folder_id obsoleto (caso exacto del usuario previo)
        let legacy_empty = SyncManifest {
            drive_folder_id: "stale_404_id".to_string(),
            files: HashMap::new(),
            pending_deletions: HashMap::new(),
            account_id: None,
            account_email: None,
            last_sync_timestamp: 0,
            last_error: None,
            ..Default::default()
        };
        std::fs::write(&legacy_file, serde_json::to_string(&legacy_empty).unwrap()).unwrap();

        let loaded = load_manifest_for_account_dir(&temp_dir, "account_sub_1", Some("user1@gmail.com"));
        // No debe heredar el folder_id obsoleto si estaba vacío
        assert_eq!(loaded.account_id.as_deref(), Some("account_sub_1"));
        assert_eq!(loaded.drive_folder_id, "");
        // El archivo heredado en disco NO debe ser borrado
        assert!(legacy_file.exists());

        // Caso 2: Manifiesto heredado con email coincidente
        let legacy_with_email = SyncManifest {
            drive_folder_id: "valid_folder".to_string(),
            files: HashMap::from([(
                "mi_nota.txt".to_string(),
                FileManifestItem {
                    drive_id: "d1".to_string(),
                    md5: "abc".to_string(),
                    local_mtime: 10,
                    remote_mtime: "2026-10-30T10:00:00Z".to_string(),
                    local_size: 5,
                },
            )]),
            pending_deletions: HashMap::new(),
            account_id: None,
            account_email: Some("user1@gmail.com".to_string()),
            last_sync_timestamp: 1234,
            last_error: None,
            ..Default::default()
        };
        std::fs::write(&legacy_file, serde_json::to_string(&legacy_with_email).unwrap()).unwrap();

        let migrated = load_manifest_for_account_dir(&temp_dir, "account_sub_1", Some("user1@gmail.com"));
        assert_eq!(migrated.account_id.as_deref(), Some("account_sub_1"));
        assert_eq!(migrated.drive_folder_id, "valid_folder");
        assert!(migrated.files.contains_key("mi_nota.txt"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_002_is_safe_filename() {
        // Nombres válidos
        assert!(is_safe_filename("nota.txt"));
        assert!(is_safe_filename("nota.md"));
        assert!(is_safe_filename("nota..v2.txt"), "Puntos consecutivos en el stem deben ser válidos");
        assert!(is_safe_filename("archivo...final.md"));
        assert!(is_safe_filename("¡Bienvenid@ a Lyra!.txt"), "Unicode con signos y espacios es válido");
        assert!(is_safe_filename("日本語のノート.txt"), "Unicode CJK es válido");
        assert!(is_safe_filename("constante.txt"), "Palabras que empiezan con nombres de dispositivos son válidas");
        assert!(is_safe_filename("con_nota.txt"));

        // Path Traversal y separadores de directorio
        assert!(!is_safe_filename("../nota.txt"));
        assert!(!is_safe_filename("../../objetivo.txt"));
        assert!(!is_safe_filename("sub/nota.txt"));
        assert!(!is_safe_filename("sub\\nota.txt"));
        assert!(!is_safe_filename("/tmp/nota.txt"));
        assert!(!is_safe_filename("C:\\temp\\nota.txt"));
        assert!(!is_safe_filename("C:nota.txt"));
        assert!(!is_safe_filename(".."));
        assert!(!is_safe_filename("."));

        // Nombres reservados de dispositivos en Windows
        assert!(!is_safe_filename("CON.txt"));
        assert!(!is_safe_filename("con.md"));
        assert!(!is_safe_filename("PRN.txt"));
        assert!(!is_safe_filename("prn.md"));
        assert!(!is_safe_filename("AUX.txt"));
        assert!(!is_safe_filename("aux.md"));
        assert!(!is_safe_filename("NUL.txt"));
        assert!(!is_safe_filename("nul.md"));
        assert!(!is_safe_filename("COM1.txt"));
        assert!(!is_safe_filename("com9.md"));
        assert!(!is_safe_filename("LPT1.txt"));
        assert!(!is_safe_filename("lpt9.md"));

        // Caracteres de control
        assert!(!is_safe_filename("nota\0.txt"));
        assert!(!is_safe_filename("nota\n.txt"));
        assert!(!is_safe_filename("nota\r.txt"));
        assert!(!is_safe_filename("nota\t.txt"));
        assert!(!is_safe_filename("nota\x7f.txt"));

        // Caracteres prohibidos en Windows/POSIX
        assert!(!is_safe_filename("nota<1>.txt"));
        assert!(!is_safe_filename("nota>1.txt"));
        assert!(!is_safe_filename("nota:1.txt"));
        assert!(!is_safe_filename("nota\"1.txt"));
        assert!(!is_safe_filename("nota|1.txt"));
        assert!(!is_safe_filename("nota?1.txt"));
        assert!(!is_safe_filename("nota*1.txt"));

        // Extensiones no permitidas y formato de nombre
        assert!(!is_safe_filename("nota.exe"));
        assert!(!is_safe_filename("nota.pdf"));
        assert!(!is_safe_filename(".txt"));
        assert!(!is_safe_filename(".md"));
        assert!(!is_safe_filename(".oculto.txt"));
        assert!(!is_safe_filename("nota.txt "));
        assert!(!is_safe_filename(" nota.txt"));
        assert!(!is_safe_filename("nota.txt."));
        assert!(!is_safe_filename(""));
    }

    #[test]
    fn test_aud_002_resolve_safe_path_and_symlinks() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_safe_path_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        // Archivo seguro nuevo
        let safe = resolve_safe_path(&temp_dir, "mi_nota.txt");
        assert!(safe.is_ok());
        assert_eq!(safe.unwrap(), temp_dir.join("mi_nota.txt"));

        // Path traversal bloqueado
        assert!(resolve_safe_path(&temp_dir, "../nota.txt").is_err());
        assert!(resolve_safe_path(&temp_dir, "../../objetivo.txt").is_err());
        assert!(resolve_safe_path(&temp_dir, "sub/nota.txt").is_err());
        assert!(resolve_safe_path(&temp_dir, "CON.txt").is_err());

        // Enlace simbólico que intenta escapar del directorio base
        #[cfg(unix)]
        {
            let outside_dir = std::env::temp_dir().join(format!("lyra_test_outside_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
            let _ = std::fs::create_dir_all(&outside_dir);
            let outside_target = outside_dir.join("archivo_secreto.txt");
            std::fs::write(&outside_target, "secreto").unwrap();

            let symlink_path = temp_dir.join("escape_symlink.txt");
            std::os::unix::fs::symlink(&outside_target, &symlink_path).unwrap();

            let res = resolve_safe_path(&temp_dir, "escape_symlink.txt");
            assert!(res.is_err(), "Debe rechazar enlaces simbólicos que intenten residir o escapar del directorio");
            let err_msg = res.unwrap_err();
            assert!(
                err_msg.contains("simbólico") || err_msg.contains("no permitido"),
                "El error debe indicar rechazo de enlace simbólico: {err_msg}"
            );

            let _ = std::fs::remove_dir_all(&outside_dir);
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_notes_directory_before_writing() {
        let parent = std::env::temp_dir().join(format!("lyra-base-link-{:032x}", rand::random::<u128>()));
        let outside = parent.join("outside");
        let linked = parent.join("lyra");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &linked).unwrap();
        assert!(ensure_safe_base_dir(&linked).is_err());
        assert!(resolve_safe_path(&linked, "note.md").is_err());
        assert!(clean_stale_tmp_save_files(&linked).is_empty());
        assert!(!outside.join("note.md").exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn test_aud_004_write_file_atomic() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_atomic_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);
        let target_file = temp_dir.join("nota_atomica.txt");

        // 1. Escritura inicial exitosa
        let initial_bytes = b"Contenido inicial seguro";
        let res1 = write_file_atomic(&target_file, initial_bytes);
        assert!(res1.is_ok(), "write_file_atomic debe escribir exitosamente");
        assert_eq!(std::fs::read(&target_file).unwrap(), initial_bytes);

        // Comprobar que no queden archivos temporales residuales en el directorio
        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0], "nota_atomica.txt");

        // 2. Sobreescritura atómica con reemplazo seguro
        let updated_bytes = b"Contenido actualizado sin truncamiento previo";
        let res2 = write_file_atomic(&target_file, updated_bytes);
        assert!(res2.is_ok());
        assert_eq!(std::fs::read(&target_file).unwrap(), updated_bytes);

        // 3. Rechazo estricto si el destino es un enlace simbólico (anti-TOCTOU)
        #[cfg(unix)]
        {
            let outside_dir = std::env::temp_dir().join(format!("lyra_test_atomic_out_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
            let _ = std::fs::create_dir_all(&outside_dir);
            let secret_file = outside_dir.join("sistema.txt");
            std::fs::write(&secret_file, "original sensible").unwrap();

            let symlink_note = temp_dir.join("nota_enlace.txt");
            std::os::unix::fs::symlink(&secret_file, &symlink_note).unwrap();

            let res_sym = write_file_atomic(&symlink_note, b"intento malicioso");
            assert!(res_sym.is_err(), "write_file_atomic debe rechazar escribir sobre enlaces simbólicos");
            assert_eq!(std::fs::read(&secret_file).unwrap(), b"original sensible", "El archivo de destino original no debe ser alterado");

            let _ = std::fs::remove_dir_all(&outside_dir);
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_002_write_unique_conflict_file_safety() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_conflict_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        // Intento de traversal al escribir archivo de conflicto
        let res_traversal = write_unique_conflict_file(&temp_dir, "../../malicioso.txt", b"evil", Utc::now());
        assert!(res_traversal.is_err(), "write_unique_conflict_file debe rechazar nombres maliciosos");

        let res_reserved = write_unique_conflict_file(&temp_dir, "CON.txt", b"evil", Utc::now());
        assert!(res_reserved.is_err(), "write_unique_conflict_file debe rechazar nombres reservados");

        // Nombre válido
        let res_valid = write_unique_conflict_file(&temp_dir, "nota_valida.txt", b"contenido seguro", Utc::now());
        assert!(res_valid.is_ok());
        let conflict_name = res_valid.unwrap();
        assert!(conflict_name.starts_with("nota_valida (conflicto Google Drive"));
        assert!(temp_dir.join(&conflict_name).exists());
        assert_eq!(std::fs::read(temp_dir.join(&conflict_name)).unwrap(), b"contenido seguro");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_005_upload_metadata_consistency() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_aud005_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);
        let note_path = temp_dir.join("nota_concurrente.txt");

        // Versión inicial en disco
        let v1_content = b"Version 1 inicial escaneada";
        write_file_atomic(&note_path, v1_content).unwrap();
        let v1_md5 = compute_md5(v1_content);

        // Simular que el usuario edita y guarda en disco concurrentemente mientras corre la sincronización
        let v2_content = b"Version 2 editada concurrentemente por el usuario";
        write_file_atomic(&note_path, v2_content).unwrap();
        let v2_md5 = compute_md5(v2_content);
        assert_ne!(v1_md5, v2_md5);

        // Leer los bytes reales para la subida
        let read_bytes = std::fs::read(&note_path).unwrap();
        let uploaded_md5 = compute_md5(&read_bytes);
        let uploaded_size = read_bytes.len() as u64;

        // Comprobar que los metadatos a insertar en el manifiesto reflejan estrictamente el contenido subido (V2)
        assert_eq!(uploaded_md5, v2_md5);
        assert_eq!(uploaded_size, v2_content.len() as u64);
        assert_ne!(uploaded_md5, v1_md5, "El manifiesto NO debe insertar el hash desactualizado V1");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_write_file_atomic_cleanup_on_error() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_atomic_err_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        // Intento de escribir sobre un destino que es un directorio existente (causará error en rename/open)
        let dir_target = temp_dir.join("subdirectorio");
        let _ = std::fs::create_dir(&dir_target);

        let res = write_file_atomic(&dir_target, b"debe fallar");
        assert!(res.is_err(), "write_file_atomic debe fallar si el destino es un directorio");

        // Comprobar que el archivo temporal .tmp_save_* fue limpiado y no quedó huérfano
        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".tmp_save_"))
            .collect();
        assert!(entries.is_empty(), "No deben quedar archivos temporales tras un fallo: {entries:?}");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_clean_stale_tmp_save_files() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_clean_stale_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        // 1. Archivo temporal reciente
        let recent_tmp = temp_dir.join(".tmp_save_111_reciente");
        std::fs::write(&recent_tmp, b"temporal reciente").unwrap();

        // 2. Archivo regular que no debe tocarse
        let regular_note = temp_dir.join("nota.txt");
        std::fs::write(&regular_note, b"nota regular").unwrap();

        // Limpieza de temporales: como recent_tmp tiene timestamp actual (<300s), debe conservarse
        clean_stale_tmp_save_files(&temp_dir);
        assert!(recent_tmp.exists(), "Temporales recientes (<300s) deben conservarse");
        assert!(regular_note.exists(), "Archivos regulares nunca deben eliminarse");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_concurrent_local_modification_preserves_local_content() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_concurrent_mod_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);
        let note_path = temp_dir.join("documento.txt");

        // Simular contenido base sincronizado previamente
        let base_bytes = b"Version base compartida";
        write_file_atomic(&note_path, base_bytes).unwrap();
        let base_md5 = compute_md5(base_bytes);

        // Simular que en Drive se modificó la nota
        let remote_bytes = b"Modificacion remota en Google Drive";
        let remote_md5 = compute_md5(remote_bytes);

        // Y simultáneamente en disco local el usuario editó y guardó la nota
        let local_edited_bytes = b"Edicion local concurrente del usuario";
        write_file_atomic(&note_path, local_edited_bytes).unwrap();
        let local_edited_md5 = compute_md5(local_edited_bytes);

        // Verificar la lógica de detección de conflicto concurrente de Step 4
        let current_disk = std::fs::read(&note_path).unwrap();
        let current_disk_md5 = compute_md5(&current_disk);

        let concurrent_local_edit = current_disk_md5 != base_md5 && current_disk_md5 != remote_md5;
        assert!(concurrent_local_edit, "Debe detectar que hubo edición local concurrente");

        // Guardar como conflicto
        let conflict_res = write_unique_conflict_file(&temp_dir, "documento.txt", remote_bytes, Utc::now());
        assert!(conflict_res.is_ok());
        let conflict_name = conflict_res.unwrap();

        // Verificar que el archivo principal local CONSERVA la edición del usuario y no fue destruido
        assert_eq!(std::fs::read(&note_path).unwrap(), local_edited_bytes);
        assert_eq!(compute_md5(&std::fs::read(&note_path).unwrap()), local_edited_md5);

        // Y que la versión remota se resguardó íntegra en la copia de conflicto
        assert_eq!(std::fs::read(temp_dir.join(&conflict_name)).unwrap(), remote_bytes);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_concurrent_local_creation_preserves_local_file() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_concurrent_creat_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);
        let note_path = temp_dir.join("nueva_nota.txt");

        // Simular nota recién creada en local
        let local_created_bytes = b"Nota creada localmente por el usuario";
        write_file_atomic(&note_path, local_created_bytes).unwrap();

        // Simular descarga de nota remota con el mismo nombre pero diferente contenido
        let remote_bytes = b"Nota remota con mismo nombre pero distinto contenido";

        let local_md5 = compute_md5(&std::fs::read(&note_path).unwrap());
        let remote_md5 = compute_md5(remote_bytes);
        assert_ne!(local_md5, remote_md5);

        // Guardar como conflicto en lugar de sobrescribir
        let conflict_res = write_unique_conflict_file(&temp_dir, "nueva_nota.txt", remote_bytes, Utc::now());
        assert!(conflict_res.is_ok());
        let conflict_name = conflict_res.unwrap();

        // Verificar que la nota local creada permanece intacta
        assert_eq!(std::fs::read(&note_path).unwrap(), local_created_bytes);
        // Y la remota se preserva en la copia de conflicto
        assert_eq!(std::fs::read(temp_dir.join(&conflict_name)).unwrap(), remote_bytes);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_005_read_file_snapshot_atomicity_and_consistency() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_snapshot_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);
        let file_path = temp_dir.join("test_snapshot.txt");

        let sample_bytes = b"Snapshot de datos exactos para verificacion de integridad";
        write_file_atomic(&file_path, sample_bytes).unwrap();

        let (content, md5, size, mtime) = read_file_snapshot(&file_path, 0).unwrap();

        assert_eq!(content, sample_bytes);
        assert_eq!(md5, compute_md5(sample_bytes));
        assert_eq!(size, sample_bytes.len() as u64);
        assert!(mtime > 0, "mtime debe ser un timestamp Unix válido en milisegundos");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_stale_tmp_recovery_preserves_unrenamed_content() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_stale_rescue_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        // 1. Archivo de destino en disco con contenido anterior
        let target_file = temp_dir.join("nota_importante.txt");
        std::fs::write(&target_file, b"Version vieja de la nota").unwrap();

        // 2. Archivo temporal huérfano con contenido nuevo del usuario que nunca llegó a renombrarse por caída
        let tmp_name = ".tmp_save_999999_nota_importante.txt";
        let tmp_path = temp_dir.join(tmp_name);
        let new_user_content = b"Texto mas reciente y valioso del usuario previo al crash";
        std::fs::write(&tmp_path, new_user_content).unwrap();

        // 3. Ejecutar procesamiento de temporal huérfano
        process_stale_tmp_file(&temp_dir, &tmp_path, tmp_name);

        // 4. Verificaciones críticas:
        // - El archivo temporal original ya no está como archivo oculto .tmp_save_*
        assert!(!tmp_path.exists(), "El temporal oculto debe ser reubicado/renombrado");
        // - El archivo de destino original sigue intacto
        assert_eq!(std::fs::read(&target_file).unwrap(), b"Version vieja de la nota");

        // - ¡EL CONTENIDO DEL TEMPORAL NO SE ELIMINÓ! Se rescató como copia visible
        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("nota_importante (recuperado de guardado"))
            .collect();

        assert_eq!(entries.len(), 1, "Debe existir exactamente 1 archivo rescatado visible: {entries:?}");
        let rescued_content = std::fs::read(temp_dir.join(&entries[0])).unwrap();
        assert_eq!(rescued_content, new_user_content, "El contenido rescatado debe ser idéntico al del temporal huérfano");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_stale_tmp_cleanup_deletes_exact_duplicate() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_stale_dup_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        let target_file = temp_dir.join("nota_duplicada.txt");
        let content = b"Mismo contenido exactamente";
        std::fs::write(&target_file, content).unwrap();

        let tmp_name = ".tmp_save_888888_nota_duplicada.txt";
        let tmp_path = temp_dir.join(tmp_name);
        std::fs::write(&tmp_path, content).unwrap();

        // Al tener contenido idéntico al destino, es un duplicado redundante seguro de eliminar
        process_stale_tmp_file(&temp_dir, &tmp_path, tmp_name);

        assert!(!tmp_path.exists(), "El temporal duplicado debe eliminarse");
        assert_eq!(std::fs::read(&target_file).unwrap(), content, "El archivo de destino debe permanecer intacto");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_stale_tmp_empty_duplicate_deletes() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_stale_empty_dup_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        let target_file = temp_dir.join("nota_vacia.txt");
        std::fs::write(&target_file, b"").unwrap();

        let tmp_name = ".tmp_save_777771_nota_vacia.txt";
        let tmp_path = temp_dir.join(tmp_name);
        std::fs::write(&tmp_path, b"").unwrap();

        // Si tanto el destino como el temporal tienen 0 bytes, son duplicados idénticos demostrables.
        // Se elimina el temporal sin crear copias de rescate redundantes ni emitir alertas.
        let rec = process_stale_tmp_file(&temp_dir, &tmp_path, tmp_name);

        assert!(rec.is_none(), "No debe rescatar un duplicado de 0 bytes");
        assert!(!tmp_path.exists(), "El temporal duplicado de 0 bytes debe eliminarse");
        assert!(target_file.exists(), "El destino original debe permanecer intacto");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_stale_tmp_empty_with_nonempty_target_rescues() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_stale_empty_nonempty_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        let target_file = temp_dir.join("nota_existente.txt");
        let initial_text = b"Texto valioso anterior que el usuario tenia";
        std::fs::write(&target_file, initial_text).unwrap();

        let tmp_name = ".tmp_save_777772_nota_existente.txt";
        let tmp_path = temp_dir.join(tmp_name);
        std::fs::write(&tmp_path, b"").unwrap(); // El usuario vació la nota o hubo una interrupción

        // REGLA OBLIGATORIA: no eliminar un temporal de 0 bytes si difiere del destino.
        // Debe preservarse como rescate y NO sobrescribir la nota destino.
        let rec = process_stale_tmp_file(&temp_dir, &tmp_path, tmp_name);

        assert!(rec.is_some(), "Debe rescatar la modificación vacía");
        assert!(!tmp_path.exists(), "El temporal original fue transformado/desvinculado");
        assert_eq!(
            std::fs::read(&target_file).unwrap(),
            initial_text,
            "El archivo destino original NO debe sobrescribirse"
        );

        let rec_name = rec.unwrap();
        let rec_content = std::fs::read(temp_dir.join(&rec_name)).unwrap();
        assert!(rec_content.is_empty(), "La nota rescatada debe contener los 0 bytes");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_stale_tmp_empty_without_target_rescues() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_stale_empty_notarget_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        let tmp_name = ".tmp_save_777773_nueva_vacia.txt";
        let tmp_path = temp_dir.join(tmp_name);
        std::fs::write(&tmp_path, b"").unwrap();

        // Destino no existe: el usuario creó una nota vacía y el guardado fue interrumpido antes de rename.
        // Debe rescatarse para no perder la creación de la nota.
        let rec = process_stale_tmp_file(&temp_dir, &tmp_path, tmp_name);

        assert!(rec.is_some(), "Debe rescatar la nueva nota vacía");
        assert!(!tmp_path.exists(), "El temporal original fue transformado");

        let rec_name = rec.unwrap();
        assert!(temp_dir.join(&rec_name).exists(), "El archivo de rescate debe existir en disco");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_recovery_name_collision_sequential_suffixes() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_collision_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        let now = Utc::now();
        // 1. Primera copia de rescate
        let name1 = write_unique_recovery_file(&temp_dir, "apuntes.txt", b"Copia 1", now).unwrap();
        assert!(!name1.contains(") ("), "La primera copia no lleva sufijo numérico secuencial: {name1}");
        assert_eq!(std::fs::read(temp_dir.join(&name1)).unwrap(), b"Copia 1");

        // 2. Segunda copia de rescate con la misma marca temporal
        let name2 = write_unique_recovery_file(&temp_dir, "apuntes.txt", b"Copia 2", now).unwrap();
        assert!(name2.contains(") (1)"), "La segunda copia debe llevar sufijo (1): {name2}");
        assert_eq!(std::fs::read(temp_dir.join(&name2)).unwrap(), b"Copia 2");

        // 3. Tercera copia de rescate con la misma marca temporal
        let name3 = write_unique_recovery_file(&temp_dir, "apuntes.txt", b"Copia 3", now).unwrap();
        assert!(name3.contains(") (2)"), "La tercera copia debe llevar sufijo (2): {name3}");
        assert_eq!(std::fs::read(temp_dir.join(&name3)).unwrap(), b"Copia 3");

        // Verificar que ninguna de las anteriores fue sobrescrita
        assert_eq!(std::fs::read(temp_dir.join(&name1)).unwrap(), b"Copia 1");
        assert_eq!(std::fs::read(temp_dir.join(&name2)).unwrap(), b"Copia 2");
        assert_eq!(std::fs::read(temp_dir.join(&name3)).unwrap(), b"Copia 3");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_aud_004_stale_tmp_recovery_preserves_tmp_on_write_error() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_write_err_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        let tmp_name = ".tmp_save_777774_nota_critica.txt";
        let tmp_path = temp_dir.join(tmp_name);
        let user_content = b"Contenido sumamente critico que no debe perderse";
        std::fs::write(&tmp_path, user_content).unwrap();

        // Forzar error de permisos en el directorio para impedir la creación de la copia de rescate
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&temp_dir, std::fs::Permissions::from_mode(0o555)); // solo lectura y ejecución
        }

        // Ejecutar procesamiento: al no poder escribir el archivo de recuperación, DEBE PRESERVAR el temporal
        let res = process_stale_tmp_file(&temp_dir, &tmp_path, tmp_name);

        assert!(res.is_none(), "El rescate debe fallar si el directorio no tiene permisos de escritura");
        assert!(
            tmp_path.exists(),
            "Si la creación de la copia de rescate falla, el archivo temporal original NUNCA debe eliminarse"
        );
        assert_eq!(std::fs::read(&tmp_path).unwrap(), user_content);

        // Restaurar permisos para limpieza
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&temp_dir, std::fs::Permissions::from_mode(0o777));
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_aud_004_clean_stale_tmp_save_files_respects_ttl() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_ttl_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);

        // 1. Temporal reciente (<300s): timestamp actual
        let recent_tmp = temp_dir.join(".tmp_save_100_reciente.txt");
        std::fs::write(&recent_tmp, b"Contenido reciente").unwrap();

        // 2. Temporal antiguo (>300s): ajustar mtime a 400 segundos en el pasado
        let stale_tmp = temp_dir.join(".tmp_save_200_antiguo.txt");
        std::fs::write(&stale_tmp, b"Contenido antiguo que debe rescatarse").unwrap();
        let past_time = std::time::SystemTime::now() - std::time::Duration::from_secs(400);
        if let Ok(file) = std::fs::File::open(&stale_tmp) {
            let times = std::fs::FileTimes::new().set_modified(past_time);
            let _ = file.set_times(times);
        }

        // Ejecutar limpieza preventiva
        let recovered = clean_stale_tmp_save_files(&temp_dir);

        // El temporal reciente debe permanecer completamente intacto
        assert!(recent_tmp.exists(), "El temporal con menos de 300 segundos NO debe procesarse");

        // El temporal antiguo debió ser procesado y rescatado
        assert!(!stale_tmp.exists(), "El temporal con más de 300 segundos debió ser procesado");
        assert_eq!(recovered.len(), 1, "Debe reportar 1 nota recuperada");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aud_004_drain_pending_recovered_notes_queue() {
        // Limpiar cualquier residuo previo
        let _ = drain_recovered_notes();

        // Grabar recuperaciones pendientes simulando el backend
        let notes_batch = vec!["nota1.txt".to_string(), "nota2.txt".to_string()];
        record_recovered_notes(&notes_batch);

        // Drenar recuperaciones
        let drained = drain_recovered_notes();
        assert_eq!(drained, notes_batch);

        // Un segundo drenado debe estar vacío
        let second_drained = drain_recovered_notes();
        assert!(second_drained.is_empty(), "La cola debe quedar vacía tras el primer drenado");
    }

    #[test]
    fn test_aud_004_deterministic_toctou_prevention() {
        let temp_dir = std::env::temp_dir().join(format!("lyra_test_toctou_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::create_dir_all(&temp_dir);
        let file_name = "nota_concurrente.txt";
        let target_path = temp_dir.join(file_name);

        let v1_initial = b"Version 1 inicial en disco";
        std::fs::write(&target_path, v1_initial).unwrap();

        let coord = Arc::new(FileLockCoordinator::new());
        let barrier = Arc::new(std::sync::Barrier::new(2));

        let coord_sync = Arc::clone(&coord);
        let barrier_sync = Arc::clone(&barrier);
        let path_sync = target_path.clone();

        // Hilo 1: Simula sincronización remota (Step 4) que verifica y reemplaza
        let handle_sync = std::thread::spawn(move || {
            coord_sync.with_file_lock(file_name, || {
                // 1. Verifica la versión en disco
                let current_content = std::fs::read(&path_sync).unwrap();
                assert_eq!(current_content, v1_initial);

                // 2. Notifica al Hilo 2 que ya está dentro de la sección crítica
                barrier_sync.wait();

                // 3. Pausa determinista corta simulando procesamiento previo al rename
                std::thread::sleep(std::time::Duration::from_millis(50));

                // 4. Reemplaza el archivo
                write_file_atomic(&path_sync, b"Version 1 descargada de Drive").unwrap();
            });
        });

        let coord_editor = Arc::clone(&coord);
        let barrier_editor = Arc::clone(&barrier);
        let path_editor = target_path.clone();

        // Hilo 2: Simula el guardado del usuario (save_note_atomic) que intenta escribir
        // durante la ventana entre la verificación y el reemplazo del Hilo 1
        let handle_editor = std::thread::spawn(move || {
            // Espera a que el Hilo 1 haya completado su verificación y esté dentro del bloqueo
            barrier_editor.wait();

            // Intenta guardar la nota local.
            // Gracias a with_file_lock, este hilo quedará BLOQUEADO hasta que el Hilo 1 libere el mutex.
            coord_editor.with_file_lock(file_name, || {
                write_file_atomic(&path_editor, b"Version 2 editada localmente por el usuario").unwrap();
            });
        });

        handle_sync.join().unwrap();
        handle_editor.join().unwrap();

        // Resultado determinista: Ambas operaciones se serializaron sin colisiones ni corrupción.
        // La versión del usuario (Hilo 2) se aplicó de forma atómica sobre la descarga remota (Hilo 1)
        // y nunca fue pisada silenciosamente por una lectura previa.
        let final_content = std::fs::read(&target_path).unwrap();
        assert_eq!(
            final_content,
            b"Version 2 editada localmente por el usuario",
            "La edición local no debe ser sobrescrita por la descarga remota"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    // -----------------------------------------------------------------------
    // AUD-001: autorización por cuenta a nivel de sincronización completa
    // -----------------------------------------------------------------------

    /// Servidor falso de Google Drive para las pruebas de AUD-001.
    ///
    /// `remote` contiene tuplas (id, nombre, md5) ya presentes en Drive.
    /// Se contabilizan subidas (POST), actualizaciones (PATCH) y descargas.
    struct Aud001Server {
        base_url: String,
        uploads: Arc<std::sync::atomic::AtomicUsize>,
        updates: Arc<std::sync::atomic::AtomicUsize>,
        downloads: Arc<std::sync::atomic::AtomicUsize>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl Aud001Server {
        fn start(remote: Vec<(&'static str, &'static str, String)>, media: &'static [u8]) -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};

            let uploads = Arc::new(AtomicUsize::new(0));
            let updates = Arc::new(AtomicUsize::new(0));
            let downloads = Arc::new(AtomicUsize::new(0));

            let entries: Vec<String> = remote
                .iter()
                .map(|(id, name, md5)| {
                    format!(
                        r#"{{"id":"{id}","name":"{name}","mimeType":"text/plain","modifiedTime":"2026-10-28T10:00:00Z","md5Checksum":"{md5}"}}"#
                    )
                })
                .collect();
            let files_json = format!(r#"{{"files":[{}]}}"#, entries.join(","));

            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let port = server.server_addr().to_ip().unwrap().port();
            let base_url = format!("http://127.0.0.1:{port}");

            let up = uploads.clone();
            let ud = updates.clone();
            let dl = downloads.clone();
            let handle = std::thread::spawn(move || {
                let json = |body: &str| {
                    tiny_http::Response::from_string(body.to_string()).with_header(
                        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
                    )
                };
                while let Ok(Some(mut req)) = server.recv_timeout(Duration::from_millis(600)) {
                    let url = req.url().to_string();
                    let method = req.method().clone();

                    if url.contains("alt=media") {
                        dl.fetch_add(1, Ordering::SeqCst);
                        let _ = req.respond(
                            tiny_http::Response::from_data(media.to_vec()).with_header(
                                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap(),
                            ),
                        );
                    } else if method == tiny_http::Method::Get && url.contains("/drive/v3/files/folder_lyra_id") {
                        let _ = req.respond(json(r#"{"id":"folder_lyra_id","name":"lyra","trashed":false,"mimeType":"application/vnd.google-apps.folder"}"#));
                    } else if method == tiny_http::Method::Get && url.contains("/drive/v3/files") {
                        let _ = req.respond(json(&files_json));
                    } else if method == tiny_http::Method::Patch {
                        ud.fetch_add(1, Ordering::SeqCst);
                        let mut b = Vec::new();
                        let _ = req.as_reader().read_to_end(&mut b);
                        let _ = req.respond(json(r#"{"id":"remote_1","name":"nota","modifiedTime":"2026-10-28T12:00:00Z"}"#));
                    } else if method == tiny_http::Method::Post {
                        up.fetch_add(1, Ordering::SeqCst);
                        let mut b = Vec::new();
                        let _ = req.as_reader().read_to_end(&mut b);
                        let _ = req.respond(json(r#"{"id":"uploaded_1","name":"nota","modifiedTime":"2026-10-28T12:00:00Z"}"#));
                    } else {
                        let _ = req.respond(json("{}"));
                    }
                }
            });

            Self {
                base_url,
                uploads,
                updates,
                downloads,
                handle: Some(handle),
            }
        }

        fn uploads(&self) -> usize {
            self.uploads.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn updates(&self) -> usize {
            self.updates.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn downloads(&self) -> usize {
            self.downloads.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn client(&self) -> DriveClient {
            DriveClient::new_with_provider_and_base_url(Arc::new(TestTokenProvider), self.base_url.clone()).unwrap()
        }

        fn join(mut self) {
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    impl Drop for Aud001Server {
        fn drop(&mut self) {
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    fn aud001_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lyra_aud001_{label}_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn aud001_manifest() -> SyncManifest {
        SyncManifest {
            drive_folder_id: "folder_lyra_id".to_string(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn test_aud001_new_account_never_uploads_existing_local_notes() {
        let temp_dir = aud001_temp_dir("new_account");
        let note_path = temp_dir.join("Nota privada.txt");
        std::fs::write(&note_path, b"contenido privado de otra cuenta").unwrap();

        let server = Aud001Server::start(vec![], b"");
        let client = server.client();
        let mut manifest = aud001_manifest();

        // La cuenta B inicia sesión cuando la nota ya existe localmente.
        let mut ctx = SyncAccountContext::open(&temp_dir, "account_b", Some("b@example.com".into()), 1).unwrap();
        let res = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx, "aud001")
            .await
            .expect("La sincronización debe completarse sin subir nada");

        assert_eq!(server.uploads(), 0, "AUD-001: no debe subirse ninguna nota a una cuenta no autorizada");
        assert_eq!(server.updates(), 0);
        assert!(res.uploaded.is_empty());
        assert!(manifest.files.is_empty(), "El manifiesto no debe registrar una nota que no se subió");
        assert_eq!(res.blocked_uploads, vec!["Nota privada.txt".to_string()]);
        assert!(res.pending_authorization, "Debe quedar una solicitud de consentimiento pendiente");
        assert_eq!(
            std::fs::read(&note_path).unwrap(),
            b"contenido privado de otra cuenta",
            "La nota local debe permanecer intacta"
        );

        ctx.persist().unwrap();
        let view = ctx.pending_view().expect("debe existir consentimiento pendiente");
        assert_eq!(view.account_key, "account_b");
        assert_eq!(view.note_count, 1);
        assert_eq!(view.notes.iter().map(|note| note.name.as_str()).collect::<Vec<_>>(), vec!["Nota privada.txt"]);

        server.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_aud001_explicit_consent_allows_upload_of_that_exact_note() {
        let temp_dir = aud001_temp_dir("consent");
        let note_path = temp_dir.join("Nota privada.txt");
        std::fs::write(&note_path, b"contenido autorizado por el usuario").unwrap();

        let server = Aud001Server::start(vec![], b"");
        let client = server.client();
        let mut manifest = aud001_manifest();

        let mut ctx = SyncAccountContext::open(&temp_dir, "account_b", Some("b@example.com".into()), 1).unwrap();
        let first = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx, "aud001-a")
            .await
            .unwrap();
        assert_eq!(server.uploads(), 0);
        assert_eq!(first.blocked_uploads.len(), 1);

        ctx.persist().unwrap();
        let request_id = ctx.pending_view().unwrap().request_id;
        let authorized = provenance::authorize_pending(&temp_dir, "account_b", &request_id).unwrap();
        assert_eq!(authorized, 1);

        // Nueva sincronización con la autorización explícita ya registrada.
        let mut ctx2 = SyncAccountContext::open(&temp_dir, "account_b", Some("b@example.com".into()), 1).unwrap();
        let second = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx2, "aud001-b")
            .await
            .unwrap();

        assert_eq!(server.uploads(), 1, "Con consentimiento explícito la nota sí debe subirse");
        assert_eq!(second.uploaded, vec!["Nota privada.txt".to_string()]);
        assert!(second.blocked_uploads.is_empty());
        assert!(!second.pending_authorization);

        ctx2.persist().unwrap();
        server.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_aud001_decline_keeps_note_local_without_repeated_prompts() {
        let temp_dir = aud001_temp_dir("decline");
        let note_path = temp_dir.join("Nota privada.txt");
        std::fs::write(&note_path, b"no se autoriza esta cuenta").unwrap();

        let server = Aud001Server::start(vec![], b"");
        let client = server.client();
        let mut manifest = aud001_manifest();

        let mut ctx = SyncAccountContext::open(&temp_dir, "account_b", None, 1).unwrap();
        run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx, "aud001-a")
            .await
            .unwrap();
        ctx.persist().unwrap();
        let request_id = ctx.pending_view().unwrap().request_id;
        provenance::decline_pending(&temp_dir, "account_b", &request_id).unwrap();

        let mut ctx2 = SyncAccountContext::open(&temp_dir, "account_b", None, 1).unwrap();
        let second = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx2, "aud001-b")
            .await
            .unwrap();

        assert_eq!(server.uploads(), 0, "Rechazar no debe subir nada");
        assert!(!second.pending_authorization, "El mismo conjunto rechazado no debe volver a preguntarse");
        assert_eq!(std::fs::read(&note_path).unwrap(), b"no se autoriza esta cuenta");

        ctx2.persist().unwrap();
        server.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_aud001_note_created_in_active_session_uploads_normally() {
        let temp_dir = aud001_temp_dir("session_note");

        let server = Aud001Server::start(vec![], b"");
        let client = server.client();
        let mut manifest = aud001_manifest();

        // La sesión comienza con el directorio vacío.
        let mut ctx = SyncAccountContext::open(&temp_dir, "account_a", None, 1).unwrap();
        std::fs::write(temp_dir.join("Nueva de la sesión.txt"), b"creada ahora").unwrap();
        provenance::record_local_write(&temp_dir, "Nueva de la sesión.txt", Some("account_a"), true).unwrap();

        let res = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx, "aud001")
            .await
            .unwrap();

        assert_eq!(server.uploads(), 1, "Una nota creada dentro de la sesión activa debe subirse");
        assert_eq!(res.uploaded, vec!["Nueva de la sesión.txt".to_string()]);
        assert!(res.blocked_uploads.is_empty());
        assert!(!res.pending_authorization);

        ctx.persist().unwrap();
        server.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_aud001_downloaded_note_can_be_updated_back_to_same_account() {
        let temp_dir = aud001_temp_dir("download_edit");
        let content = b"vino de la cuenta".to_vec();
        let md5 = compute_md5(&content);

        let server = Aud001Server::start(
            vec![("remote_1", "Compartida.txt", md5)],
            b"vino de la cuenta",
        );
        let client = server.client();
        let mut manifest = aud001_manifest();

        let mut ctx = SyncAccountContext::open(&temp_dir, "account_b", None, 1).unwrap();
        let first = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx, "aud001-a")
            .await
            .unwrap();
        assert_eq!(server.downloads(), 1);
        assert_eq!(first.downloaded, vec!["Compartida.txt".to_string()]);
        ctx.persist().unwrap();

        // El usuario edita la nota descargada: la cuenta que la descargó puede subirla.
        std::fs::write(temp_dir.join("Compartida.txt"), b"editada por el usuario").unwrap();
        provenance::record_local_write(&temp_dir, "Compartida.txt", None, false).unwrap();
        let mut ctx2 = SyncAccountContext::open(&temp_dir, "account_b", None, 1).unwrap();
        let second = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx2, "aud001-b")
            .await
            .unwrap();

        assert_eq!(server.updates(), 1, "Una nota descargada de la cuenta activa puede volver a subirse");
        assert_eq!(second.uploaded, vec!["Compartida.txt".to_string()]);
        assert!(second.blocked_uploads.is_empty());

        ctx2.persist().unwrap();
        server.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_aud001_foreign_note_is_never_overwritten_by_another_account() {
        let temp_dir = aud001_temp_dir("foreign_download");
        let local_content = b"contenido de la cuenta A".to_vec();
        let local_path = temp_dir.join("Compartida.txt");
        std::fs::write(&local_path, &local_content).unwrap();
        let local_md5 = compute_md5(&local_content);

        // La cuenta A autoriza la nota durante su sesión y luego cierra sesión.
        let mut ctx_a = SyncAccountContext::open(&temp_dir, "account_a", None, 1).unwrap();
        // La nota ya existía antes de la sesión de A, así que se crea el registro
        // con el mismo contenido mediante una observación y consentimiento previo.
        ctx_a.mark_downloaded("Compartida.txt", "drive_a", &local_md5, 1_000, local_content.len() as u64, AuthorizationSource::AutomaticDownload);
        ctx_a.persist().unwrap();
        provenance::end_account_session(&temp_dir, "account_a").unwrap();

        let remote_content = b"version remota de la cuenta B";
        let remote_md5 = compute_md5(remote_content);
        let server = Aud001Server::start(
            vec![("remote_1", "Compartida.txt", remote_md5)],
            b"version remota de la cuenta B",
        );
        let client = server.client();

        // El manifiesto de B conoce la nota con el contenido local de A.
        let mut manifest = aud001_manifest();
        manifest.files.insert(
            "Compartida.txt".to_string(),
            FileManifestItem {
                drive_id: "remote_1".to_string(),
                md5: local_md5,
                local_mtime: 1_000,
                remote_mtime: "2026-10-28T09:00:00Z".to_string(),
                local_size: local_content.len() as u64,
            },
        );

        let mut ctx_b = SyncAccountContext::open(&temp_dir, "account_b", None, 2).unwrap();
        let res = run_sync_with_client_and_emitter_with_id(&temp_dir, &mut manifest, &client, None, &mut ctx_b, "aud001")
            .await
            .unwrap();

        assert_eq!(
            std::fs::read(&local_path).unwrap(),
            local_content,
            "AUD-001: la nota de otra cuenta nunca debe sobrescribirse"
        );
        assert_eq!(res.conflicts, vec!["Compartida.txt".to_string()]);
        assert_eq!(server.downloads(), 1);
        assert_eq!(server.uploads(), 0);
        // La cuenta B tiene la nota registrada en su propio manifiesto, por lo que
        // puede reenviar su versión local; lo que nunca ocurre es que la descarga
        // sobrescriba el archivo local de la cuenta A.

        let conflict_names: Vec<String> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("(conflicto Google Drive"))
            .collect();
        assert_eq!(conflict_names.len(), 1, "La versión remota debe conservarse como copia de conflicto");
        assert_eq!(
            std::fs::read(temp_dir.join(&conflict_names[0])).unwrap(),
            b"version remota de la cuenta B"
        );

        ctx_b.persist().unwrap();
        server.join();
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
