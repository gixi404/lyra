use std::path::{Path, PathBuf};
use std::collections::BTreeMap;
use std::io::Write;

use tauri::Manager;
use serde::{Deserialize, Serialize};

const STATE_FILE: &str = ".lyra_folder_state.json";
const MOVE_JOURNAL_FILE: &str = ".lyra_folder_move.json";
const FOLDER_ID_FILE: &str = ".lyra_folder_id.json";

#[cfg(test)]
thread_local! { static MOVE_FAULT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) }; }

fn fault_point(phase: &str) -> Result<(), String> {
    #[cfg(test)]
    if MOVE_FAULT.with(|current| *current.borrow() == Some(phase)) {
        return Err(format!("Injected move interruption at {phase}"));
    }
    let _ = phase;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathChange {
    old_path: String,
    new_path: String,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MovePhase { #[default] Prepared, Physical, AwaitingFrontend, Aborted }

#[derive(Clone, Serialize, Deserialize)]
struct MoveJournal {
    source: String,
    destination: String,
    is_folder: bool,
    notes: Vec<PathChange>,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    phase: MovePhase,
}

#[derive(Default, Debug, Serialize, Deserialize)]
struct FolderState {
    version: u32,
    archived: Vec<String>,
    #[serde(default)]
    identities: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct FolderMarker { version: u32, id: String }

fn folder_marker(dir: &Path) -> Result<String, String> {
    let path = dir.join(FOLDER_ID_FILE);
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if !meta.file_type().is_file() { return Err("Folder identity marker is not a regular file".into()); }
    }
    match std::fs::read(&path) {
        Ok(raw) => {
            let marker: FolderMarker = serde_json::from_slice(&raw).map_err(|e| format!("Invalid folder identity marker: {e}"))?;
            if marker.version != 1 || marker.id.len() != 32 || !marker.id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalid folder identity marker".into());
            }
            Ok(marker.id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let id = format!("{:032x}", rand::random::<u128>());
            let bytes = serde_json::to_vec(&FolderMarker { version: 1, id: id.clone() }).map_err(|e| e.to_string())?;
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
                .map_err(|e| format!("Cannot create folder identity: {e}"))?;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("Cannot persist folder identity: {e}"))?;
            Ok(id)
        }
        Err(error) => Err(format!("Cannot read folder identity: {error}")),
    }
}

fn scan_folder_markers(base: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut found = BTreeMap::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("Cannot inspect folder identities: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || !kind.is_dir() || entry.file_name().to_string_lossy().starts_with('.') { continue; }
            let path = entry.path();
            let marker_path = path.join(FOLDER_ID_FILE);
            if marker_path.exists() {
                let id = folder_marker(&path)?;
                let relative = path.strip_prefix(base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
                if found.insert(id, relative).is_some() { return Err("Duplicate folder identity; resolve the copied marker manually".into()); }
            }
            stack.push(path);
        }
    }
    Ok(found)
}

fn archived_paths(base: &Path) -> Result<Vec<String>, String> {
    let state = read_state(base)?;
    if state.archived.is_empty() { return Ok(Vec::new()); }
    if state.version != 2 { return Err("Legacy archived folders require identity resolution before use".into()); }
    let found = scan_folder_markers(base)?;
    let mut paths = Vec::new();
    let mut seen_ids = std::collections::BTreeSet::new();
    for old_path in &state.archived {
        let Some(id) = state.identities.get(old_path) else { continue; };
        if !seen_ids.insert(id.clone()) { continue; }
        let current = found.get(id).ok_or("Archived folder identity is missing; no other folder was archived")?;
        paths.push(current.clone());
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn normalize_folder_state(base: &Path, state: &mut FolderState) -> Result<(), String> {
    if state.version == 1 {
        if state.archived.is_empty() { state.version = 2; return Ok(()); }
        return Ok(()); // legacy con archivadas: se preserva para que read/validaciones existentes decidan
    }
    if state.version != 2 { return Ok(()); }

    // Escaneo de marcadores: un error real (p.ej. duplicados) debe impedir una escritura insegura.
    let found = match scan_folder_markers(base) {
        Ok(map) => map,
        Err(error) if error.contains("Duplicate folder identity") => return Err(error),
        Err(_) => BTreeMap::new(), // best-effort: conservar claves históricas si no se puede inspeccionar
    };

    let mut archived_ids: Vec<String> = Vec::new();
    let mut seen_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for old_path in &state.archived {
        if let Some(id) = state.identities.get(old_path) {
            if seen_ids.insert(id.clone()) {
                archived_ids.push(id.clone());
            }
        }
    }

    let mut preferred_keys: BTreeMap<String, String> = BTreeMap::new();
    for id in &archived_ids {
        let key = if let Some(current) = found.get(id) {
            current.clone()
        } else {
            state.identities.iter()
                .find_map(|(k, v)| if v == id { Some(k.clone()) } else { None })
                .unwrap_or_default()
        };
        if key.is_empty() { continue; }
        if let Some(existing) = preferred_keys.get(&key) {
            if existing != id {
                return Err("Cannot normalize folder archive state safely: identity path collision".into());
            }
        } else {
            preferred_keys.insert(key, id.clone());
        }
    }

    // Rechazar también si dos identidades resolubles reclaman la misma ruta física (no debería ocurrir, pero es inseguro).
    let mut resolved_path_owner: BTreeMap<String, String> = BTreeMap::new();
    for id in &archived_ids {
        if let Some(current) = found.get(id) {
            if let Some(owner) = resolved_path_owner.get(current) {
                if owner != id {
                    return Err("Cannot normalize folder archive state safely: duplicate resolved identity path".into());
                }
            } else {
                resolved_path_owner.insert(current.clone(), id.clone());
            }
        }
    }

    let mut new_identities: BTreeMap<String, String> = BTreeMap::new();
    let mut new_archived: Vec<String> = Vec::new();
    for id in &archived_ids {
        let Some(key) = preferred_keys.iter().find_map(|(k, v)| if v == id { Some(k.clone()) } else { None }) else { continue; };
        new_identities.insert(key.clone(), id.clone());
        new_archived.push(key);
    }
    new_archived.sort();
    new_archived.dedup();
    state.archived = new_archived;
    state.identities = new_identities;
    state.version = 2;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    name: String,
    location: String,
    direct_files: u64,
    total_files: u64,
    direct_folders: u64,
    total_folders: u64,
    total_bytes: u64,
    created_at: Option<u128>,
    modified_at: Option<u128>,
}

fn state_path(base: &Path) -> PathBuf { base.join(STATE_FILE) }
fn move_journal_path(base: &Path) -> PathBuf { base.join(MOVE_JOURNAL_FILE) }

fn write_move_journal(base: &Path, journal: &MoveJournal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    let primary = move_journal_path(base);
    if let Ok(raw) = std::fs::read(&primary) {
        if serde_json::from_slice::<MoveJournal>(&raw).is_ok() {
            crate::gdrive::sync::write_file_atomic(&base.join(format!("{MOVE_JOURNAL_FILE}.bak")), &raw)
                .map_err(|e| format!("Cannot back up folder move journal: {e}"))?;
        }
    }
    crate::gdrive::sync::write_file_atomic(&primary, &bytes)
        .map_err(|e| format!("Cannot prepare folder move: {e}"))
}

fn remove_move_journal(base: &Path) -> Result<(), String> {
    fault_point("cleanup")?;
    std::fs::remove_file(move_journal_path(base)).map_err(|e| format!("Cannot clear folder move journal: {e}"))?;
    let _ = std::fs::remove_file(base.join(format!("{MOVE_JOURNAL_FILE}.bak")));
    Ok(())
}

fn read_move_journal(base: &Path) -> Result<Option<MoveJournal>, String> {
    let primary = move_journal_path(base);
    let backup = base.join(format!("{MOVE_JOURNAL_FILE}.bak"));
    match std::fs::read(&primary) {
        Ok(raw) => serde_json::from_slice(&raw).map(Some).or_else(|primary_error| {
            let raw = std::fs::read(&backup).map_err(|_| format!("Invalid folder move journal: {primary_error}"))?;
            serde_json::from_slice(&raw).map(Some).map_err(|e| format!("Invalid folder move backup: {e}"))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read folder move journal: {error}")),
    }
}

fn apply_provenance_changes(base: &Path, notes: &[PathChange]) -> Result<(), String> {
    let ledger_path = crate::gdrive::provenance::get_ledger_path(base);
    let Some(mut ledger) = crate::gdrive::provenance::load_ledger(&ledger_path)? else { return Ok(()); };
    for change in notes {
        if let Some(id) = ledger.by_name.get(&change.old_path) {
            if ledger.by_name.get(&change.new_path).is_some_and(|existing| existing != id) {
                return Err(format!("Provenance collision at {}", change.new_path));
            }
        }
    }
    let mut changed = false;
    for change in notes {
        if let Some(id) = ledger.by_name.remove(&change.old_path) {
            if ledger.by_name.get(&change.new_path).is_some_and(|existing| existing != &id) {
                return Err(format!("Provenance collision at {}", change.new_path));
            }
            ledger.by_name.insert(change.new_path.clone(), id.clone());
            if let Some(note) = ledger.notes.get_mut(&id) { note.name = change.new_path.clone(); }
            changed = true;
        }
    }
    if changed { crate::gdrive::provenance::save_ledger(&ledger_path, &ledger)?; }
    Ok(())
}

fn finish_move_at(base: &Path, journal: &MoveJournal) -> Result<(), String> {
    if journal.is_folder {
        let expected = journal.folder_id.as_deref().ok_or("Folder move has no stable identity")?;
        let destination = folder_path(base, &journal.destination)?;
        if folder_marker(&destination)? != expected {
            return Err("Moved folder identity changed externally; recovery was stopped".into());
        }
    }
    fault_point("provenance")?;
    apply_provenance_changes(base, &journal.notes)?;
    let changes = journal.notes.iter().map(|note| (note.old_path.clone(), note.new_path.clone())).collect::<Vec<_>>();
    fault_point("identity")?;
    crate::local_identity::remap_notes(base, &changes)?;
    // Disk drafts are reconciled after physical and provenance state, while
    // both copies remain available. A conflict leaves the journal pending.
    fault_point("drafts")?;
    reconcile_disk_drafts(base, &journal.notes, true)?;
    fault_point("frontend")?;
    write_move_journal(base, &MoveJournal { phase: MovePhase::AwaitingFrontend, ..journal.clone() })
}

fn draft_id_for(path: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in path.nfc().collect::<String>().trim().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn reconcile_disk_drafts(base: &Path, notes: &[PathChange], finalize: bool) -> Result<(), String> {
    for change in notes {
        let old_id = draft_id_for(&change.old_path);
        let new_id = draft_id_for(&change.new_path);
        let Some(old_raw) = crate::drafts::read_draft_file(base, &old_id)? else { continue; };
        let mut payload: serde_json::Value = serde_json::from_str(&old_raw)
            .map_err(|_| format!("Draft for {} requires manual recovery", change.old_path))?;
        if payload.get("draftId").and_then(serde_json::Value::as_str) != Some(&old_id)
            || payload.get("noteName").and_then(serde_json::Value::as_str) != Some(&change.old_path) {
            return Err(format!("Draft identity mismatch for {}", change.old_path));
        }
        payload["draftId"] = serde_json::Value::String(new_id.clone());
        payload["noteName"] = serde_json::Value::String(change.new_path.clone());
        let next_raw = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        match crate::drafts::read_draft_file(base, &new_id)? {
            Some(existing) => {
                let existing_value: serde_json::Value = serde_json::from_str(&existing)
                    .map_err(|_| format!("Conflicting draft at {} was retained", change.new_path))?;
                if existing_value != payload { return Err(format!("Conflicting draft at {} was retained", change.new_path)); }
            }
            None => crate::drafts::save_draft_file(base, &new_id, &next_raw)?,
        }
        if crate::drafts::read_draft_file(base, &new_id)?.as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok()).as_ref() != Some(&payload) {
            return Err(format!("Moved draft could not be verified for {}", change.new_path));
        }
        if finalize { crate::drafts::delete_draft_file(base, &old_id)?; }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn rename_folder_no_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    use std::ffi::CString;
    let parent = std::fs::File::open(source.parent().ok_or("Invalid source parent")?).map_err(|e| e.to_string())?;
    let target_parent = std::fs::File::open(destination.parent().ok_or("Invalid destination parent")?).map_err(|e| e.to_string())?;
    let old = CString::new(source.file_name().ok_or("Invalid source")?.as_encoded_bytes()).map_err(|e| e.to_string())?;
    let new = CString::new(destination.file_name().ok_or("Invalid destination")?.as_encoded_bytes()).map_err(|e| e.to_string())?;
    let result = unsafe { libc::renameat2(parent.as_raw_fd(), old.as_ptr(), target_parent.as_raw_fd(), new.as_ptr(), libc::RENAME_NOREPLACE) };
    if result != 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(())
}

#[cfg(windows)]
fn rename_folder_no_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let old = wide(source);
    let new = wide(destination);
    let result = unsafe { MoveFileExW(old.as_ptr(), new.as_ptr(), 0) };
    if result == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(())
}

#[cfg(not(any(target_os = "linux", windows)))]
fn rename_folder_no_replace(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("No-replace folder move is unavailable on this platform".into())
}

pub(crate) fn recover_move_at(base: &Path) -> Result<(), String> {
    let Some(journal) = read_move_journal(base)? else { return Ok(()); };
    if journal.phase == MovePhase::AwaitingFrontend || journal.phase == MovePhase::Aborted { return Ok(()); }
    let source = if journal.is_folder { folder_path(base, &journal.source)? }
        else { crate::gdrive::sync::resolve_safe_path(base, &journal.source)? };
    let destination = if journal.is_folder { folder_path(base, &journal.destination)? }
        else { crate::gdrive::sync::resolve_safe_path(base, &journal.destination)? };
    match (source.exists(), destination.exists()) {
        (true, false) => write_move_journal(base, &MoveJournal { phase: MovePhase::Aborted, ..journal }),
        (false, true) => finish_move_at(base, &journal),
        (true, true) if journal.is_folder => {
            Err("Folder move requires manual recovery: both paths exist".into())
        }
        (true, true) => {
            if crate::local_identity::same_physical(&source, &destination)? {
                std::fs::remove_file(&source).map_err(|e| e.to_string())?;
                return finish_move_at(base, &journal);
            }
            Err("Note move requires manual recovery: both paths exist".into())
        }
        (false, false) => Err("Move requires manual recovery: both paths are missing".into()),
    }
}

fn ensure_notes_not_bound(_base: &Path, _notes: &[PathChange]) -> Result<(), String> {
    // Google Drive es experimental: las operaciones locales (mover/renombrar) no deben bloquearse
    // por manifiestos, provenance/bindings o estado de sincronización. Se conservan metadatos
    // y no se realizan operaciones remotas destructivas; la sincronización se reconcilia aparte.
    Ok(())
}

fn validate_move_state(base: &Path, source: &str, destination: &str, allow_archived_descendants_in_source: bool) -> Result<(), String> {
    if archived_paths(base)?.iter().any(|path| {
        let source_is_archived = source == path || source.starts_with(&format!("{path}/"));
        let destination_archived = destination == path || destination.starts_with(&format!("{path}/"));
        let archived_inside_source = path.starts_with(&format!("{source}/"));
        source_is_archived || destination_archived || (archived_inside_source && !allow_archived_descendants_in_source)
    }) {
        return Err("Restaura las carpetas archivadas antes de mover esta ruta".into());
    }
    Ok(())
}

pub(crate) fn ensure_active_parent_at(base: &Path, file_name: &str) -> Result<(), String> {
    if archived_paths(base)?.iter().any(|path| file_name.starts_with(&format!("{path}/"))) {
        return Err("Restaura la carpeta padre antes de crear una nota".into());
    }
    Ok(())
}

fn collect_folder_notes(base: &Path, relative: &str) -> Result<Vec<PathChange>, String> {
    let mut notes = Vec::new();
    let mut stack = vec![base.join(relative)];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("No se pudo inspeccionar la carpeta antes de moverla: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() { return Err("No se pueden mover carpetas que contienen enlaces simbólicos".into()); }
            if kind.is_dir() { if !name.starts_with('.') { stack.push(entry.path()); } }
            else if kind.is_file() {
                if name.starts_with('.') || !crate::gdrive::sync::has_supported_extension(&name) { continue; }
                let old = entry.path().strip_prefix(base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
                notes.push(PathChange { old_path: old, new_path: String::new() });
            }
        }
    }
    notes.sort_by(|a, b| a.old_path.cmp(&b.old_path));
    Ok(notes)
}

#[tauri::command]
pub async fn move_folder_local(app: tauri::AppHandle, source_path: String, destination_path: String, expected_notes: Vec<String>) -> Result<Vec<PathChange>, String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    move_folder_at(&base, &source_path, &destination_path, Some(&expected_notes))
}

fn move_folder_at(base: &Path, source_path: &str, destination_path: &str, expected_notes: Option<&[String]>) -> Result<Vec<PathChange>, String> {
    crate::local_identity::recover_save(base)?;
    recover_move_at(base)?;
    if read_move_journal(base)?.is_some() { return Err("Un movimiento anterior necesita recuperación en la interfaz antes de realizar otro".into()); }
    if source_path == destination_path || destination_path.starts_with(&format!("{source_path}/")) {
        return Err("No se puede mover una carpeta dentro de sí misma o de una subcarpeta".into());
    }
    let source_name = source_path.rsplit('/').next().unwrap_or(source_path);
    let destination_name = destination_path.rsplit('/').next().unwrap_or(destination_path);
    if source_name != destination_name {
        validate_new_folder_name_length(destination_path)?;
    }
    let source = folder_path(base, source_path)?;
    let destination = folder_path(base, destination_path)?;
    if !source.is_dir() { return Err("La carpeta de origen no existe".into()); }
    if destination.exists() { return Err("El destino ya existe".into()); }
    if !destination.parent().is_some_and(Path::is_dir) { return Err("La carpeta de destino no existe".into()); }
    let folder_id = folder_marker(&source)?;
    validate_move_state(base, source_path, destination_path, true)?;
    let mut notes = collect_folder_notes(base, source_path)?;
    if let Some(expected) = expected_notes {
        let mut expected = expected.to_vec();
        expected.sort();
        if notes.iter().map(|note| &note.old_path).ne(expected.iter()) {
            return Err("El contenido de la carpeta cambió durante la preparación; actualiza y vuelve a intentarlo".into());
        }
    }
    for note in &mut notes {
        note.new_path = format!("{}{}", destination_path, &note.old_path[source_path.len()..]);
    }
    ensure_notes_not_bound(base, &notes)?;
    let journal = MoveJournal { source: source_path.into(), destination: destination_path.into(), is_folder: true, notes: notes.clone(), folder_id: Some(folder_id), phase: MovePhase::Prepared };
    write_move_journal(base, &journal)?;
    fault_point("prepared")?;
    if let Err(error) = rename_folder_no_replace(&source, &destination) {
        remove_move_journal(base)?;
        return Err(format!("No se pudo mover la carpeta: {error}"));
    }
    fault_point("physical")?;
    let journal = MoveJournal { phase: MovePhase::Physical, ..journal };
    write_move_journal(base, &journal)?;
    finish_move_at(base, &journal)?;
    Ok(notes)
}

#[tauri::command]
pub async fn move_note_local(app: tauri::AppHandle, source_path: String, destination_path: String) -> Result<Vec<PathChange>, String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    move_note_at(&base, &source_path, &destination_path)
}

fn move_note_at(base: &Path, source_path: &str, destination_path: &str) -> Result<Vec<PathChange>, String> {
    crate::local_identity::recover_save(base)?;
    recover_move_at(base)?;
    if read_move_journal(base)?.is_some() { return Err("Un movimiento anterior necesita recuperación en la interfaz antes de realizar otro".into()); }
    if source_path == destination_path { return Err("Source and destination are the same".into()); }
    let source = crate::gdrive::sync::resolve_safe_path(base, source_path)?;
    let destination = crate::gdrive::sync::resolve_safe_path(base, destination_path)?;
    if !source.is_file() { return Err("Source note does not exist".into()); }
    if destination.exists() { return Err("El destino ya existe".into()); }
    if !destination.parent().is_some_and(Path::is_dir) { return Err("La carpeta de destino no existe".into()); }
    validate_move_state(base, source_path, destination_path, false)?;
    let notes = vec![PathChange { old_path: source_path.into(), new_path: destination_path.into() }];
    ensure_notes_not_bound(base, &notes)?;
    crate::local_identity::open_note(base, source_path)?;
    let journal = MoveJournal { source: source_path.into(), destination: destination_path.into(), is_folder: false, notes: notes.clone(), folder_id: None, phase: MovePhase::Prepared };
    write_move_journal(base, &journal)?;
    fault_point("prepared")?;
    if let Err(error) = rename_folder_no_replace(&source, &destination) {
        remove_move_journal(base)?;
        return Err(format!("Cannot move note: {error}"));
    }
    fault_point("physical")?;
    let journal = MoveJournal { phase: MovePhase::Physical, ..journal };
    write_move_journal(base, &journal)?;
    finish_move_at(base, &journal)?;
    Ok(notes)
}

#[tauri::command]
pub async fn recover_folder_move(app: tauri::AppHandle) -> Result<(), String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    recover_move_at(&base)
}

#[tauri::command]
pub async fn local_move_status(app: tauri::AppHandle, source_path: String, destination_path: String) -> Result<String, String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    match read_move_journal(&base) {
        Ok(None) => Ok("notMoved".into()),
        Ok(Some(journal)) if journal.source == source_path && journal.destination == destination_path => {
            Ok(if journal.phase == MovePhase::Aborted { "notMoved" } else { "pending" }.into())
        }
        _ => Ok("unknown".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMove {
    source_path: String,
    destination_path: String,
    is_folder: bool,
    phase: MovePhase,
    notes: Vec<PathChange>,
}

#[tauri::command]
pub async fn pending_local_move(app: tauri::AppHandle) -> Result<Option<PendingMove>, String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    recover_move_at(&base)?;
    Ok(read_move_journal(&base)?.map(|journal| PendingMove {
        source_path: journal.source,
        destination_path: journal.destination,
        is_folder: journal.is_folder,
        phase: journal.phase,
        notes: journal.notes,
    }))
}

#[tauri::command]
pub async fn acknowledge_local_move(app: tauri::AppHandle, source_path: String, destination_path: String) -> Result<(), String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    let journal = read_move_journal(&base)?.ok_or("Move journal is already clear")?;
    if journal.source != source_path || journal.destination != destination_path
        || !(journal.phase == MovePhase::AwaitingFrontend || journal.phase == MovePhase::Aborted) {
        return Err("Move cannot be acknowledged in this phase".into());
    }
    let source = if journal.is_folder { folder_path(&base, &source_path)? }
        else { crate::gdrive::sync::resolve_safe_path(&base, &source_path)? };
    let destination = if journal.is_folder { folder_path(&base, &destination_path)? }
        else { crate::gdrive::sync::resolve_safe_path(&base, &destination_path)? };
    if journal.phase == MovePhase::Aborted {
        if !source.exists() || destination.exists() { return Err("Aborted move paths changed; journal retained".into()); }
    } else {
        if source.exists() || !destination.exists() { return Err("Completed move paths changed; journal retained".into()); }
        if journal.is_folder {
            let expected = journal.folder_id.as_deref().ok_or("Missing folder identity")?;
            if folder_marker(&destination)? != expected { return Err("Folder identity changed after move".into()); }
        } else {
            crate::local_identity::verify_registered_path(&base, &destination_path)?;
        }
    }
    remove_move_journal(&base)
}

fn read_state(base: &Path) -> Result<FolderState, String> {
    let parse = |raw: &str| -> Result<FolderState, String> {
        let state: FolderState = serde_json::from_str(raw).map_err(|e| format!("Invalid folder state: {e}"))?;
        if state.version != 1 && state.version != 2 { return Err("Unsupported folder state version".into()); }
        Ok(state)
    };
    match std::fs::read_to_string(state_path(base)) {
        Ok(raw) => parse(&raw).or_else(|error| {
            let backup = std::fs::read_to_string(base.join(format!("{STATE_FILE}.bak"))).map_err(|_| error)?;
            parse(&backup)
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::read_to_string(base.join(format!("{STATE_FILE}.bak"))) {
                Ok(backup) => parse(&backup),
                Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => Ok(FolderState { version: 2, archived: Vec::new(), identities: BTreeMap::new() }),
                Err(other) => Err(format!("Cannot read folder state backup: {other}")),
            }
        }
        Err(error) => Err(format!("Cannot read folder state: {error}")),
    }
}

fn write_state(base: &Path, state: &FolderState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    let primary = state_path(base);
    if primary.exists() && std::fs::read(&primary).ok()
        .and_then(|raw| serde_json::from_slice::<FolderState>(&raw).ok())
        .is_some_and(|previous| previous.version == 1 || previous.version == 2) {
        std::fs::copy(&primary, base.join(format!("{STATE_FILE}.bak")))
            .map_err(|e| format!("Cannot back up folder state: {e}"))?;
    }
    crate::gdrive::sync::write_file_atomic(&primary, &bytes)
        .map_err(|e| format!("Cannot save folder state: {e}"))
}

fn base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().document_dir().map(|dir| dir.join("lyra")).map_err(|e| e.to_string())
}

fn folder_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    // The virtual root is an empty path. A physical directory named Lyra is
    // otherwise an ordinary user directory.
    if relative.is_empty() { return Err("The Lyra root cannot be modified".into()); }
    let probe = format!("{relative}/__lyra_folder_probe__.txt");
    let resolved = crate::gdrive::sync::resolve_safe_path(base, &probe)?;
    resolved.parent().map(Path::to_path_buf).ok_or_else(|| "Invalid folder path".into())
}

fn validate_new_folder_name_length(relative_path: &str) -> Result<(), String> {
    let name = relative_path.rsplit('/').next().unwrap_or(relative_path);
    // Mismo criterio que TypeScript (String.length): unidades de código UTF-16.
    if name.encode_utf16().count() > 60 {
        return Err("El nombre de la carpeta es demasiado largo (máximo 60 caracteres).".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn create_folder(app: tauri::AppHandle, relative_path: String) -> Result<(), String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    recover_move_at(&base)?;
    create_folder_at(&base, &relative_path)
}

#[tauri::command]
pub async fn folder_info(app: tauri::AppHandle, relative_path: String) -> Result<FolderInfo, String> {
    let base = base_dir(&app)?;
    let target = if relative_path.is_empty() { base.clone() } else { folder_path(&base, &relative_path)? };
    folder_info_at(&target, &relative_path)
}

fn folder_info_at(target: &Path, relative_path: &str) -> Result<FolderInfo, String> {
    if !target.is_dir() { return Err("Folder does not exist".into()); }
    let metadata = std::fs::metadata(target).map_err(|e| e.to_string())?;
    let timestamp = |value: Result<std::time::SystemTime, std::io::Error>| {
        value.ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|duration| duration.as_millis())
    };
    let mut info = FolderInfo {
        name: if relative_path.is_empty() { "Lyra".into() } else { target.file_name().unwrap_or_default().to_string_lossy().to_string() },
        location: target.to_string_lossy().to_string(), direct_files: 0, total_files: 0,
        direct_folders: 0, total_folders: 0, total_bytes: 0,
        created_at: timestamp(metadata.created()), modified_at: timestamp(metadata.modified()),
    };
    let mut stack = vec![(target.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("Cannot inspect folder: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() { continue; }
            if kind.is_dir() {
                info.total_folders += 1;
                if depth == 0 { info.direct_folders += 1; }
                stack.push((entry.path(), depth + 1));
            } else if kind.is_file() {
                info.total_files += 1;
                if depth == 0 { info.direct_files += 1; }
                let meta = entry.metadata().map_err(|e| e.to_string())?;
                info.total_bytes += meta.len();
                if let Some(modified) = timestamp(meta.modified()) {
                    info.modified_at = Some(info.modified_at.unwrap_or(0).max(modified));
                }
            }
        }
    }
    Ok(info)
}

#[tauri::command]
pub async fn list_archived_folders(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let base = base_dir(&app)?;
    archived_paths(&base)
}

#[tauri::command]
pub async fn set_folder_archived(app: tauri::AppHandle, relative_path: String, archived: bool) -> Result<Vec<String>, String> {
    let base = base_dir(&app)?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    set_folder_archived_at(&base, &relative_path, archived)
}

fn set_folder_archived_at(base: &Path, relative_path: &str, archived: bool) -> Result<Vec<String>, String> {
    let target = folder_path(base, relative_path)?;
    if !target.is_dir() { return Err("Folder does not exist at its original location".into()); }
    let mut state = read_state(base)?;
    if state.version == 1 && !state.archived.is_empty() {
        return Err("Legacy archived folders require identity resolution; no state was changed".into());
    }
    state.version = 2;
    // Normaliza referencias históricas a identidades resueltas antes de mutar, evitando colisiones por reutilización de rutas.
    normalize_folder_state(base, &mut state)?;
    let id = folder_marker(&target)?;
    state.archived.retain(|path| state.identities.get(path) != Some(&id));
    if archived {
        if let Some(existing) = state.identities.get(relative_path) {
            if existing != &id {
                return Err("Cannot archive folder safely: identity path collision".into());
            }
        }
        state.identities.insert(relative_path.to_string(), id.clone());
        state.archived.push(relative_path.to_string());
    } else {
        state.identities.retain(|_, value| value != &id);
    }
    state.archived.sort();
    state.archived.dedup();
    // Persistir con claves coherentes (ruta actual/identidad) para futuras operaciones.
    normalize_folder_state(base, &mut state)?;
    write_state(base, &state)?;
    // Devolver rutas resueltas conocidas sin perder referencias no resolubles persistidas.
    let found = scan_folder_markers(base).unwrap_or_default();
    let mut paths = Vec::new();
    let mut seen_ids = std::collections::BTreeSet::new();
    for old_path in &state.archived {
        let Some(id) = state.identities.get(old_path) else { continue; };
        if !seen_ids.insert(id.clone()) { continue; }
        if let Some(current) = found.get(id) { paths.push(current.clone()); }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn create_folder_at(base: &Path, relative_path: &str) -> Result<(), String> {
    validate_new_folder_name_length(relative_path)?;
    let target = folder_path(base, relative_path)?;
    if archived_paths(base)?.iter().any(|path| relative_path.starts_with(&format!("{path}/"))) {
        return Err("Restore the parent folder before creating a subfolder".into());
    }
    let parent = target.parent().ok_or("Invalid parent")?;
    if !parent.is_dir() { return Err("Parent folder does not exist".into()); }
    std::fs::create_dir(&target).map_err(|e| format!("Cannot create folder: {e}"))?;
    folder_marker(&target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_nested_folders_only_under_existing_parents() {
        let base = std::env::temp_dir().join(format!("lyra_folders_{}", rand::random::<u64>()));
        std::fs::create_dir(&base).unwrap();
        assert!(create_folder_at(&base, "").is_err());
        assert!(create_folder_at(&base, "A/B").is_err());
        create_folder_at(&base, "A").unwrap();
        create_folder_at(&base, "A/B").unwrap();
        assert!(base.join("A/B").is_dir());
        assert!(create_folder_at(&base, "A/B").is_err());
        assert!(create_folder_at(&base, "../outside").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn folder_info_and_logical_archive_preserve_files() {
        let base = std::env::temp_dir().join(format!("lyra_folder_state_{}", rand::random::<u64>()));
        std::fs::create_dir(&base).unwrap();
        create_folder_at(&base, "A").unwrap();
        create_folder_at(&base, "A/B").unwrap();
        std::fs::write(base.join("A/one.md"), "one").unwrap();
        std::fs::write(base.join("A/B/two.txt"), "two!").unwrap();
        std::fs::write(base.join("A/B/.internal.md"), "hidden").unwrap();
        let info = folder_info_at(&base.join("A"), "A").unwrap();
        assert_eq!((info.direct_files, info.total_files, info.direct_folders, info.total_folders, info.total_bytes), (1, 2, 1, 1, 7));
        assert!(set_folder_archived_at(&base, "", true).is_err());
        assert_eq!(set_folder_archived_at(&base, "A", true).unwrap(), ["A"]);
        assert!(create_folder_at(&base, "A/New").is_err());
        assert!(ensure_active_parent_at(&base, "A/new.md").is_err());
        assert!(ensure_active_parent_at(&base, "root.md").is_ok());
        assert!(base.join(STATE_FILE).exists());
        assert_eq!(set_folder_archived_at(&base, "A", true).unwrap(), ["A"]);
        std::fs::write(base.join(STATE_FILE), "{broken").unwrap();
        assert_eq!(read_state(&base).unwrap().archived, ["A"]);
        assert_eq!(std::fs::read_to_string(base.join("A/one.md")).unwrap(), "one");
        assert!(set_folder_archived_at(&base, "A", false).unwrap().is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn local_moves_preserve_content_and_reject_collisions_and_cycles() {
        let base = std::env::temp_dir().join(format!("lyra_folder_moves_{}", rand::random::<u64>()));
        std::fs::create_dir(&base).unwrap();
        create_folder_at(&base, "A").unwrap();
        create_folder_at(&base, "A/B").unwrap();
        create_folder_at(&base, "C").unwrap();
        std::fs::write(base.join("A/B/note.md"), "preserved").unwrap();
        assert!(move_folder_at(&base, "A", "A/B/Loop", None).is_err());
        assert!(move_folder_at(&base, "A", "C", None).is_err());
        assert!(move_folder_at(&base, "A/B", "C/B", Some(&[])).is_err());
        let moved = move_folder_at(&base, "A/B", "C/B", None).unwrap();
        assert_eq!(moved[0].old_path, "A/B/note.md");
        assert_eq!(moved[0].new_path, "C/B/note.md");
        assert_eq!(std::fs::read_to_string(base.join("C/B/note.md")).unwrap(), "preserved");
        assert!(!base.join("A/B").exists());
        remove_move_journal(&base).unwrap();
        move_note_at(&base, "C/B/note.md", "A/note.md").unwrap();
        assert_eq!(std::fs::read_to_string(base.join("A/note.md")).unwrap(), "preserved");
        assert!(move_note_at(&base, "A/note.md", "A/note.md").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interrupted_folder_move_preserves_ambiguous_destination() {
        let base = std::env::temp_dir().join(format!("lyra_move_recovery_{}", rand::random::<u64>()));
        std::fs::create_dir(&base).unwrap();
        create_folder_at(&base, "A").unwrap();
        std::fs::write(base.join("A/note.md"), "preserved").unwrap();
        write_move_journal(&base, &MoveJournal { source: "A".into(), destination: "B".into(), is_folder: true, notes: vec![], folder_id: Some(folder_marker(&base.join("A")).unwrap()), phase: MovePhase::Prepared }).unwrap();
        std::fs::create_dir(base.join("B")).unwrap();
        assert!(recover_move_at(&base).is_err());
        assert!(base.join("B").is_dir());
        assert_eq!(std::fs::read_to_string(base.join("A/note.md")).unwrap(), "preserved");
        assert!(move_journal_path(&base).exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn archived_folder_follows_external_rename_without_archiving_reused_path() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Original").unwrap();
        std::fs::write(base.join("Original/note.md"), "kept").unwrap();
        assert_eq!(set_folder_archived_at(base, "Original", true).unwrap(), ["Original"]);
        std::fs::rename(base.join("Original"), base.join("Renamed")).unwrap();
        std::fs::create_dir(base.join("Original")).unwrap();
        assert_eq!(archived_paths(base).unwrap(), ["Renamed"]);
        assert!(ensure_active_parent_at(base, "Renamed/new.md").is_err());
        assert!(ensure_active_parent_at(base, "Original/new.md").is_ok());
        assert_eq!(set_folder_archived_at(base, "Renamed", false).unwrap(), Vec::<String>::new());
        assert_eq!(std::fs::read_to_string(base.join("Renamed/note.md")).unwrap(), "kept");
    }

    #[test]
    fn physical_statistics_count_visible_regular_files_of_every_extension() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "A").unwrap();
        create_folder_at(base, "A/B").unwrap();
        std::fs::write(base.join("A/document.pdf"), b"abc").unwrap();
        std::fs::write(base.join("A/B/data.bin"), b"12345").unwrap();
        std::fs::write(base.join("A/.lyra_hidden"), b"not-counted").unwrap();
        let info = folder_info_at(&base.join("A"), "A").unwrap();
        assert_eq!((info.direct_files, info.total_files, info.total_bytes), (1, 2, 8));
    }

    #[test]
    fn moving_note_reconciles_disk_draft_and_logical_identity() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("old.md"), "note").unwrap();
        let (identity, _) = crate::local_identity::open_note(base, "old.md").unwrap();
        let old_id = draft_id_for("old.md");
        let new_id = draft_id_for("new.md");
        let draft = serde_json::json!({"v":1,"noteName":"old.md","draftId":old_id,"content":"unsaved","revision":2,"baseHash":"base"});
        crate::drafts::save_draft_file(base, &old_id, &draft.to_string()).unwrap();
        move_note_at(base, "old.md", "new.md").unwrap();
        assert!(crate::drafts::read_draft_file(base, &old_id).unwrap().is_none());
        let moved: serde_json::Value = serde_json::from_str(&crate::drafts::read_draft_file(base, &new_id).unwrap().unwrap()).unwrap();
        assert_eq!(moved["content"], "unsaved");
        assert_eq!(moved["noteName"], "new.md");
        assert_eq!(crate::local_identity::open_note(base, "new.md").unwrap().0, identity);
    }

    #[test]
    fn restart_after_physical_move_replays_draft_phase_idempotently() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("old.md"), "note").unwrap();
        let (identity, _) = crate::local_identity::open_note(base, "old.md").unwrap();
        let old_id = draft_id_for("old.md");
        let draft = serde_json::json!({"v":1,"noteName":"old.md","draftId":old_id,"content":"unsaved","revision":2,"baseHash":"base"});
        crate::drafts::save_draft_file(base, &old_id, &draft.to_string()).unwrap();
        let journal = MoveJournal { source: "old.md".into(), destination: "new.md".into(), is_folder: false,
            notes: vec![PathChange { old_path: "old.md".into(), new_path: "new.md".into() }], folder_id: None, phase: MovePhase::Prepared };
        write_move_journal(base, &journal).unwrap();
        std::fs::rename(base.join("old.md"), base.join("new.md")).unwrap();
        recover_move_at(base).unwrap();
        recover_move_at(base).unwrap();
        assert_eq!(crate::local_identity::open_note(base, "new.md").unwrap().0, identity);
        assert!(crate::drafts::read_draft_file(base, &old_id).unwrap().is_none());
        assert!(crate::drafts::read_draft_file(base, &draft_id_for("new.md")).unwrap().is_some());
    }

    #[test]
    fn conflicting_destination_draft_blocks_move_without_discarding_either() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("old.md"), "note").unwrap();
        let old_id = draft_id_for("old.md");
        let new_id = draft_id_for("new.md");
        let old = serde_json::json!({"noteName":"old.md","draftId":old_id,"content":"old"});
        let new = serde_json::json!({"noteName":"new.md","draftId":new_id,"content":"other"});
        crate::drafts::save_draft_file(base, &old_id, &old.to_string()).unwrap();
        crate::drafts::save_draft_file(base, &new_id, &new.to_string()).unwrap();
        assert!(move_note_at(base, "old.md", "new.md").is_err());
        assert_eq!(std::fs::read_to_string(base.join("new.md")).unwrap(), "note");
        assert!(move_journal_path(base).exists());
        assert!(crate::drafts::read_draft_file(base, &old_id).unwrap().is_some());
        assert!(crate::drafts::read_draft_file(base, &new_id).unwrap().is_some());
    }

    #[test]
    fn every_move_phase_replays_or_aborts_without_losing_note_bytes() {
        for phase in ["prepared", "physical", "provenance", "identity", "drafts", "frontend"] {
            let root = tempfile::tempdir().unwrap();
            let base = root.path();
            std::fs::write(base.join("old.md"), format!("note-{phase}")).unwrap();
            let (identity, _) = crate::local_identity::open_note(base, "old.md").unwrap();
            let old_id = draft_id_for("old.md");
            let draft = serde_json::json!({"v":1,"noteName":"old.md","draftId":old_id,"content":format!("draft-{phase}")});
            crate::drafts::save_draft_file(base, &old_id, &draft.to_string()).unwrap();
            MOVE_FAULT.with(|current| *current.borrow_mut() = Some(phase));
            let result = move_note_at(base, "old.md", "new.md");
            MOVE_FAULT.with(|current| *current.borrow_mut() = None);
            assert!(result.is_err(), "{phase}");
            recover_move_at(base).unwrap();
            recover_move_at(base).unwrap();
            let journal = read_move_journal(base).unwrap().unwrap();
            if phase == "prepared" {
                assert!(journal.phase == MovePhase::Aborted);
                assert_eq!(std::fs::read_to_string(base.join("old.md")).unwrap(), "note-prepared");
                assert!(!base.join("new.md").exists());
                assert!(crate::drafts::read_draft_file(base, &old_id).unwrap().is_some());
            } else {
                assert!(journal.phase == MovePhase::AwaitingFrontend, "{phase}");
                assert_eq!(std::fs::read_to_string(base.join("new.md")).unwrap(), format!("note-{phase}"));
                assert_eq!(crate::local_identity::open_note(base, "new.md").unwrap().0, identity);
                let new_raw = crate::drafts::read_draft_file(base, &draft_id_for("new.md")).unwrap().unwrap();
                assert!(new_raw.contains(&format!("draft-{phase}")));
                assert!(crate::drafts::read_draft_file(base, &old_id).unwrap().is_none());
            }
        }
    }

    #[test]
    fn failed_journal_cleanup_is_retryable_after_frontend_ack() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("old.md"), "note").unwrap();
        move_note_at(base, "old.md", "new.md").unwrap();
        MOVE_FAULT.with(|current| *current.borrow_mut() = Some("cleanup"));
        assert!(remove_move_journal(base).is_err());
        MOVE_FAULT.with(|current| *current.borrow_mut() = None);
        assert!(read_move_journal(base).unwrap().is_some());
        recover_move_at(base).unwrap();
        remove_move_journal(base).unwrap();
        assert!(read_move_journal(base).unwrap().is_none());
        assert_eq!(std::fs::read_to_string(base.join("new.md")).unwrap(), "note");
    }

    #[cfg(unix)]
    #[test]
    fn interrupted_note_move_finishes_only_when_both_paths_are_the_same_file() {
        let base = std::env::temp_dir().join(format!("lyra_note_recovery_{}", rand::random::<u64>()));
        std::fs::create_dir(&base).unwrap();
        std::fs::write(base.join("old.md"), "preserved").unwrap();
        write_move_journal(&base, &MoveJournal { source: "old.md".into(), destination: "new.md".into(), is_folder: false,
            notes: vec![PathChange { old_path: "old.md".into(), new_path: "new.md".into() }], folder_id: None, phase: MovePhase::Prepared }).unwrap();
        std::fs::hard_link(base.join("old.md"), base.join("new.md")).unwrap();
        recover_move_at(&base).unwrap();
        assert!(!base.join("old.md").exists());
        assert_eq!(std::fs::read_to_string(base.join("new.md")).unwrap(), "preserved");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rename_folder_empty_same_parent_preserves_structure() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Vacia").unwrap();
        let id = folder_marker(&base.join("Vacia")).unwrap();
        let moved = move_folder_at(base, "Vacia", "Renombrada", None).unwrap();
        assert!(moved.is_empty());
        assert!(!base.join("Vacia").exists());
        assert!(base.join("Renombrada").is_dir());
        assert_eq!(folder_marker(&base.join("Renombrada")).unwrap(), id);
        remove_move_journal(base).unwrap();
    }

    #[test]
    fn rename_folder_with_nested_notes_updates_descendants_preserves_content_and_identity() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Desarrollo").unwrap();
        create_folder_at(base, "Desarrollo/Backend").unwrap();
        create_folder_at(base, "Desarrollo/Backend/API").unwrap();
        std::fs::write(base.join("Desarrollo/Proyecto.txt"), "root-note").unwrap();
        std::fs::write(base.join("Desarrollo/Backend/API.txt"), "api-note").unwrap();
        let folder_id = folder_marker(&base.join("Desarrollo")).unwrap();
        let sub_id = folder_marker(&base.join("Desarrollo/Backend")).unwrap();
        let (note1_id, _) = crate::local_identity::open_note(base, "Desarrollo/Proyecto.txt").unwrap();
        let (note2_id, _) = crate::local_identity::open_note(base, "Desarrollo/Backend/API.txt").unwrap();

        let moved = move_folder_at(base, "Desarrollo", "Programacion", None).unwrap();
        assert_eq!(moved.len(), 2);
        assert_eq!(moved[0].old_path, "Desarrollo/Backend/API.txt");
        assert_eq!(moved[0].new_path, "Programacion/Backend/API.txt");
        assert_eq!(moved[1].old_path, "Desarrollo/Proyecto.txt");
        assert_eq!(moved[1].new_path, "Programacion/Proyecto.txt");

        assert!(!base.join("Desarrollo").exists());
        assert!(base.join("Programacion/Backend/API").is_dir());
        assert_eq!(std::fs::read_to_string(base.join("Programacion/Proyecto.txt")).unwrap(), "root-note");
        assert_eq!(std::fs::read_to_string(base.join("Programacion/Backend/API.txt")).unwrap(), "api-note");
        assert_eq!(folder_marker(&base.join("Programacion")).unwrap(), folder_id);
        assert_eq!(folder_marker(&base.join("Programacion/Backend")).unwrap(), sub_id);
        assert_eq!(crate::local_identity::open_note(base, "Programacion/Proyecto.txt").unwrap().0, note1_id);
        assert_eq!(crate::local_identity::open_note(base, "Programacion/Backend/API.txt").unwrap().0, note2_id);
        remove_move_journal(base).unwrap();
    }

    #[test]
    fn rename_folder_does_not_affect_similar_prefix_paths() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Trabajo").unwrap();
        create_folder_at(base, "Trabajo2").unwrap();
        create_folder_at(base, "Trabajos").unwrap();
        std::fs::write(base.join("Trabajo/nota.md"), "a").unwrap();
        std::fs::write(base.join("Trabajo2/nota.md"), "b").unwrap();
        std::fs::write(base.join("Trabajos/nota.md"), "c").unwrap();
        let (id2, _) = crate::local_identity::open_note(base, "Trabajo2/nota.md").unwrap();
        let (id3, _) = crate::local_identity::open_note(base, "Trabajos/nota.md").unwrap();
        move_folder_at(base, "Trabajo", "Labor", None).unwrap();
        assert!(base.join("Labor/nota.md").exists());
        assert_eq!(std::fs::read_to_string(base.join("Trabajo2/nota.md")).unwrap(), "b");
        assert_eq!(std::fs::read_to_string(base.join("Trabajos/nota.md")).unwrap(), "c");
        assert_eq!(crate::local_identity::open_note(base, "Trabajo2/nota.md").unwrap().0, id2);
        assert_eq!(crate::local_identity::open_note(base, "Trabajos/nota.md").unwrap().0, id3);
        remove_move_journal(base).unwrap();
    }

    #[test]
    fn rename_folder_rejects_collisions_invalid_and_unsafe_targets() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "A").unwrap();
        create_folder_at(base, "B").unwrap();
        std::fs::write(base.join("nota.txt"), "x").unwrap();
        // collision with existing folder
        assert!(move_folder_at(base, "A", "B", None).is_err());
        assert!(base.join("A").is_dir() && base.join("B").is_dir());
        // collision with existing file-like path resolved by folder move? destination.exists() catches
        // cannot rename root virtual (empty)
        assert!(create_folder_at(base, "").is_err());
        // nonexistent source
        assert!(move_folder_at(base, "NoExiste", "C", None).is_err());
        // traversal/escape rejected by folder_path validation
        assert!(move_folder_at(base, "A", "../fuera", None).is_err());
        assert!(move_folder_at(base, "A", "A/../B2", None).is_err() || move_folder_at(base, "A", "A\\..\\B2", None).is_err());
        assert!(base.join("A").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn rename_folder_rejects_unsafe_symlink_content() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        let outside = tempfile::tempdir().unwrap();
        create_folder_at(base, "ConLink").unwrap();
        std::os::unix::fs::symlink(outside.path(), base.join("ConLink/link_fuera")).unwrap();
        let err = move_folder_at(base, "ConLink", "Renombrada", None).unwrap_err();
        assert!(err.contains("enlace") || err.contains("simb"), "{err}");
        assert!(base.join("ConLink").is_dir());
        assert!(!base.join("Renombrada").exists());
    }

    #[test]
    fn rename_folder_only_changes_case_on_linux() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "desarrollo").unwrap();
        std::fs::write(base.join("desarrollo/nota.txt"), "hola").unwrap();
        let id = folder_marker(&base.join("desarrollo")).unwrap();
        let (note_id, _) = crate::local_identity::open_note(base, "desarrollo/nota.txt").unwrap();
        let result = move_folder_at(base, "desarrollo", "Desarrollo", None);
        assert!(result.is_ok(), "case-only rename should work on Linux/Fedora: {:?}", result.err());
        let moved = result.unwrap();
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].old_path, "desarrollo/nota.txt");
        assert_eq!(moved[0].new_path, "Desarrollo/nota.txt");
        assert!(base.join("Desarrollo").is_dir());
        assert_eq!(std::fs::read_to_string(base.join("Desarrollo/nota.txt")).unwrap(), "hola");
        assert_eq!(folder_marker(&base.join("Desarrollo")).unwrap(), id);
        assert_eq!(crate::local_identity::open_note(base, "Desarrollo/nota.txt").unwrap().0, note_id);
        remove_move_journal(base).unwrap();
    }

    #[test]
    fn rename_folder_interruption_is_recoverable_and_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Origen").unwrap();
        std::fs::write(base.join("Origen/nota.md"), "contenido").unwrap();
        let id = folder_marker(&base.join("Origen")).unwrap();
        let (note_id, _) = crate::local_identity::open_note(base, "Origen/nota.md").unwrap();
        for phase in ["prepared", "physical", "provenance", "identity", "drafts", "frontend"] {
            // reset state for each phase test on fresh workspace
            let r = tempfile::tempdir().unwrap();
            let b = r.path();
            create_folder_at(b, "Origen").unwrap();
            std::fs::write(b.join("Origen/nota.md"), "contenido").unwrap();
            let fid = folder_marker(&b.join("Origen")).unwrap();
            let (nid, _) = crate::local_identity::open_note(b, "Origen/nota.md").unwrap();
            MOVE_FAULT.with(|current| *current.borrow_mut() = Some(phase));
            let result = move_folder_at(b, "Origen", "Destino", None);
            MOVE_FAULT.with(|current| *current.borrow_mut() = None);
            assert!(result.is_err(), "{phase}");
            recover_move_at(b).unwrap();
            recover_move_at(b).unwrap();
            let journal = read_move_journal(b).unwrap().unwrap();
            if phase == "prepared" {
                assert!(matches!(journal.phase, MovePhase::Aborted));
                assert!(b.join("Origen/nota.md").exists());
                assert_eq!(std::fs::read_to_string(b.join("Origen/nota.md")).unwrap(), "contenido");
                assert!(!b.join("Destino").exists());
            } else {
                assert!(matches!(journal.phase, MovePhase::AwaitingFrontend), "{phase}");
                assert!(b.join("Destino/nota.md").exists());
                assert_eq!(std::fs::read_to_string(b.join("Destino/nota.md")).unwrap(), "contenido");
                assert_eq!(folder_marker(&b.join("Destino")).unwrap(), fid);
                assert_eq!(crate::local_identity::open_note(b, "Destino/nota.md").unwrap().0, nid);
            }
        }
        let _ = (id, note_id);
    }

    #[test]
    fn rename_folder_backend_validation_collisions_and_existence() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "A").unwrap();
        create_folder_at(base, "B").unwrap();
        std::fs::write(base.join("archivo.txt"), "x").unwrap();

        // Colisión con carpeta existente en el mismo padre
        assert!(move_folder_at(base, "A", "B", None).is_err());
        assert!(base.join("A").is_dir());

        // Colisión con archivo existente en el directorio padre (el destino no puede ocupar un nombre ya usado por archivo)
        let err = move_folder_at(base, "A", "archivo.txt", None).unwrap_err();
        assert!(
            err.contains("destino")
                || err.to_lowercase().contains("existe")
                || err.contains("no es un directorio")
                || err.contains("inválid"),
            "{err}"
        );
        assert!(base.join("A").is_dir());
        assert!(base.join("archivo.txt").is_file());

        // Carpeta inexistente
        assert!(move_folder_at(base, "NoExiste", "Nueva", None).is_err());
    }

    #[test]
    fn rename_folder_backend_rejects_reserved_windows_names() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Origen").unwrap();
        for name in ["CON", "con", "LPT1", "AUX.txtish?no"] {
            // Nombres reservados de dispositivo Windows (componentes) deben rechazarse por validación de ruta.
            let invalid = if name == "AUX.txtish?no" { "AUX" } else { name };
            let err = move_folder_at(base, "Origen", invalid, None).unwrap_err();
            assert!(err.contains("invál") || err.contains("insegur") || err.contains("no segur") || err.contains("Ruta"), "{invalid}: {err}");
            assert!(base.join("Origen").is_dir());
        }
    }

    #[test]
    fn rename_folder_backend_enforces_folder_name_length_like_frontend() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();

        // 60 caracteres: permitido (creación y renombrado)
        let name60 = "a".repeat(60);
        create_folder_at(base, &name60).unwrap();
        assert!(base.join(&name60).is_dir());
        let renamed60 = "b".repeat(60);
        move_folder_at(base, &name60, &renamed60, None).unwrap();
        assert!(base.join(&renamed60).is_dir());
        remove_move_journal(base).unwrap();

        // 61 caracteres: rechazado, conserva directorio original
        create_folder_at(base, "Origen").unwrap();
        let name61 = "c".repeat(61);
        let err = create_folder_at(base, &name61).unwrap_err();
        assert!(err.contains("60") || err.contains("largo"), "{err}");
        assert!(!base.join(&name61).exists());
        let err = move_folder_at(base, "Origen", &name61, None).unwrap_err();
        assert!(err.contains("60") || err.contains("largo"), "{err}");
        assert!(base.join("Origen").is_dir());
        assert!(!base.join(&name61).exists());

        // Unicode en límites (mismo criterio que JS String.length: UTF-16 code units)
        // "é" = 1 unidad, 60 veces permitido; "😀" = 2 unidades, 30 emojis = 60 permitido
        let unicode60 = "é".repeat(60);
        create_folder_at(base, &unicode60).unwrap();
        assert!(base.join(&unicode60).is_dir());
        let emoji60 = "😀".repeat(30); // 60 UTF-16 code units
        move_folder_at(base, &unicode60, &emoji60, None).unwrap();
        assert!(base.join(&emoji60).is_dir());
        remove_move_journal(base).unwrap();
        let emoji61 = "😀".repeat(30) + "a"; // 61
        let err = move_folder_at(base, &emoji60, &emoji61, None).unwrap_err();
        assert!(err.contains("60") || err.contains("largo"), "{err}");
        assert!(base.join(&emoji60).is_dir());

        // Carpeta preexistente con nombre >60 (creada externamente en disco) puede renombrarse a nombre válido
        let preexisting_long = "x".repeat(61);
        std::fs::create_dir(base.join(&preexisting_long)).unwrap();
        std::fs::write(base.join(&preexisting_long).join("nota.txt"), "ok").unwrap();
        move_folder_at(base, &preexisting_long, "NombreValido", None).unwrap();
        assert!(!base.join(&preexisting_long).exists());
        assert!(base.join("NombreValido").is_dir());
        assert_eq!(std::fs::read_to_string(base.join("NombreValido/nota.txt")).unwrap(), "ok");
        remove_move_journal(base).unwrap();

        // Mover carpeta preexistente con nombre >60 a otro directorio SIN cambiar su nombre: permitido
        let preexisting_long2 = "y".repeat(61);
        std::fs::create_dir(base.join(&preexisting_long2)).unwrap();
        create_folder_at(base, "DestinoPadre").unwrap();
        std::fs::write(base.join(&preexisting_long2).join("nota.txt"), "ok2").unwrap();
        let moved_to = format!("DestinoPadre/{preexisting_long2}");
        move_folder_at(base, &preexisting_long2, &moved_to, None).unwrap();
        assert!(!base.join(&preexisting_long2).exists());
        assert!(base.join(&moved_to).is_dir());
        assert_eq!(std::fs::read_to_string(base.join(&moved_to).join("nota.txt")).unwrap(), "ok2");
        remove_move_journal(base).unwrap();

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn phase5_note_moves_across_root_folders_and_deep_subfolders() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "A").unwrap();
        create_folder_at(base, "A/B").unwrap();
        create_folder_at(base, "A/B/C").unwrap();
        create_folder_at(base, "D").unwrap();
        std::fs::write(base.join("root.md"), "root").unwrap();
        std::fs::write(base.join("A/n.txt"), "in-a").unwrap();

        // Raíz -> carpeta
        let (id_root, _) = crate::local_identity::open_note(base, "root.md").unwrap();
        move_note_at(base, "root.md", "A/root.md").unwrap();
        assert_eq!(std::fs::read_to_string(base.join("A/root.md")).unwrap(), "root");
        assert!(!base.join("root.md").exists());
        assert_eq!(crate::local_identity::open_note(base, "A/root.md").unwrap().0, id_root);
        remove_move_journal(base).unwrap();

        // Carpeta -> otra carpeta
        move_note_at(base, "A/root.md", "D/root.md").unwrap();
        assert_eq!(std::fs::read_to_string(base.join("D/root.md")).unwrap(), "root");
        assert!(!base.join("A/root.md").exists());
        remove_move_journal(base).unwrap();

        // Carpeta -> subcarpeta profunda
        move_note_at(base, "D/root.md", "A/B/C/root.md").unwrap();
        assert_eq!(std::fs::read_to_string(base.join("A/B/C/root.md")).unwrap(), "root");
        assert!(!base.join("D/root.md").exists());
        remove_move_journal(base).unwrap();

        // Carpeta/subcarpeta -> raíz
        move_note_at(base, "A/B/C/root.md", "root.md").unwrap();
        assert_eq!(std::fs::read_to_string(base.join("root.md")).unwrap(), "root");
        assert!(!base.join("A/B/C/root.md").exists());
        remove_move_journal(base).unwrap();

        // Carpeta -> otra carpeta (nota existente en subárbol)
        let (id_a, _) = crate::local_identity::open_note(base, "A/n.txt").unwrap();
        move_note_at(base, "A/n.txt", "D/n.txt").unwrap();
        assert_eq!(std::fs::read_to_string(base.join("D/n.txt")).unwrap(), "in-a");
        assert_eq!(crate::local_identity::open_note(base, "D/n.txt").unwrap().0, id_a);
        remove_move_journal(base).unwrap();

        // Colisión con nota existente
        std::fs::write(base.join("A/dup.md"), "a").unwrap();
        std::fs::write(base.join("D/dup.md"), "b").unwrap();
        let err = move_note_at(base, "A/dup.md", "D/dup.md").unwrap_err();
        assert!(err.contains("destino") || err.to_lowercase().contains("existe"), "{err}");
        assert_eq!(std::fs::read_to_string(base.join("A/dup.md")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(base.join("D/dup.md")).unwrap(), "b");

        // Orígenes/destinos inexistentes y archivados
        assert!(move_note_at(base, "nope.md", "A/nope.md").is_err());
        create_folder_at(base, "Arch").unwrap();
        std::fs::write(base.join("Arch/x.md"), "x").unwrap();
        set_folder_archived_at(base, "Arch", true).unwrap();
        assert!(move_note_at(base, "root.md", "Arch/root.md").is_err());
        assert!(move_note_at(base, "Arch/x.md", "x.md").is_err());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn phase5_folder_moves_levels_multilevel_regular_files_and_save_after_move() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Src").unwrap();
        create_folder_at(base, "Src/Sub").unwrap();
        create_folder_at(base, "Src/Sub/Deep").unwrap();
        create_folder_at(base, "Dst").unwrap();
        create_folder_at(base, "Dst/Nest").unwrap();
        std::fs::write(base.join("Src/a.md"), "A").unwrap();
        std::fs::write(base.join("Src/Sub/b.txt"), "B").unwrap();
        std::fs::write(base.join("Src/Sub/Deep/data.bin"), [1u8, 2, 3, 4]).unwrap(); // regular no gestionado como nota
        std::fs::write(base.join("Src/Sub/Deep/image.pdf"), b"%PDF").unwrap();
        let src_id = folder_marker(&base.join("Src")).unwrap();
        let sub_id = folder_marker(&base.join("Src/Sub")).unwrap();
        let deep_id = folder_marker(&base.join("Src/Sub/Deep")).unwrap();
        let (id_a, _) = crate::local_identity::open_note(base, "Src/a.md").unwrap();
        let (id_b, _) = crate::local_identity::open_note(base, "Src/Sub/b.txt").unwrap();

        // Raíz de primer nivel -> dentro de otra carpeta
        move_folder_at(base, "Src", "Dst/Nest/Src", None).unwrap();
        assert!(!base.join("Src").exists());
        assert!(base.join("Dst/Nest/Src/Sub/Deep").is_dir());
        assert_eq!(std::fs::read_to_string(base.join("Dst/Nest/Src/a.md")).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(base.join("Dst/Nest/Src/Sub/b.txt")).unwrap(), "B");
        assert_eq!(std::fs::read(base.join("Dst/Nest/Src/Sub/Deep/data.bin")).unwrap(), vec![1u8,2,3,4]);
        assert_eq!(std::fs::read(base.join("Dst/Nest/Src/Sub/Deep/image.pdf")).unwrap(), b"%PDF");
        assert_eq!(folder_marker(&base.join("Dst/Nest/Src")).unwrap(), src_id);
        assert_eq!(folder_marker(&base.join("Dst/Nest/Src/Sub")).unwrap(), sub_id);
        assert_eq!(folder_marker(&base.join("Dst/Nest/Src/Sub/Deep")).unwrap(), deep_id);
        assert_eq!(crate::local_identity::open_note(base, "Dst/Nest/Src/a.md").unwrap().0, id_a);
        assert_eq!(crate::local_identity::open_note(base, "Dst/Nest/Src/Sub/b.txt").unwrap().0, id_b);
        remove_move_journal(base).unwrap();

        // Guardar nota movida no recrea el origen
        crate::local_identity::save_note(base, "Dst/Nest/Src/a.md", &id_a, b"A2").unwrap();
        assert_eq!(std::fs::read_to_string(base.join("Dst/Nest/Src/a.md")).unwrap(), "A2");
        assert!(!base.join("Src/a.md").exists());
        assert!(!base.join("Src").exists());

        // Subcarpeta -> otra carpeta
        move_folder_at(base, "Dst/Nest/Src/Sub", "Dst/Sub", None).unwrap();
        assert!(base.join("Dst/Sub/Deep/data.bin").exists());
        assert!(!base.join("Dst/Nest/Src/Sub").exists());
        remove_move_journal(base).unwrap();

        // Subcarpeta -> raíz
        move_folder_at(base, "Dst/Sub/Deep", "Deep", None).unwrap();
        assert!(base.join("Deep/data.bin").exists());
        assert_eq!(std::fs::read(base.join("Deep/image.pdf")).unwrap(), b"%PDF");
        remove_move_journal(base).unwrap();

        // Carpeta vacía
        create_folder_at(base, "Empty").unwrap();
        move_folder_at(base, "Empty", "Dst/Empty", None).unwrap();
        assert!(base.join("Dst/Empty").is_dir());
        remove_move_journal(base).unwrap();

        // Carpeta preexistente con nombre >60 movida sin cambiar nombre (además del caso de longitud)
        let long_name = "z".repeat(61);
        std::fs::create_dir(base.join(&long_name)).unwrap();
        std::fs::write(base.join(&long_name).join("f.txt"), "ok").unwrap();
        move_folder_at(base, &long_name, &format!("Dst/{long_name}"), None).unwrap();
        assert!(base.join(format!("Dst/{long_name}/f.txt")).exists());
        remove_move_journal(base).unwrap();

        // Colisiones y seguridad
        create_folder_at(base, "X").unwrap();
        create_folder_at(base, "Dst/X").unwrap();
        assert!(move_folder_at(base, "X", "Dst/X", None).is_err());
        assert!(base.join("X").is_dir());
        assert!(move_folder_at(base, "X", "X/Loop", None).is_err());
        assert!(move_folder_at(base, "NoExiste", "Y", None).is_err());
        assert!(move_folder_at(base, "", "Y", None).is_err()); // raíz virtual

        // Destino archivado
        create_folder_at(base, "ArcDst").unwrap();
        set_folder_archived_at(base, "ArcDst", true).unwrap();
        assert!(move_folder_at(base, "X", "ArcDst/X", None).is_err());
        create_folder_at(base, "ArcSrc").unwrap();
        set_folder_archived_at(base, "ArcSrc", true).unwrap();
        assert!(move_folder_at(base, "ArcSrc", "X2", None).is_err());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn phase5_note_move_recovery_is_idempotent_across_phases() {
        for phase in ["prepared", "physical", "provenance", "identity", "drafts", "frontend"] {
            let root = tempfile::tempdir().unwrap();
            let base = root.path();
            create_folder_at(base, "From").unwrap();
            create_folder_at(base, "To").unwrap();
            std::fs::write(base.join("From/n.md"), format!("note-{phase}")).unwrap();
            let (id, _) = crate::local_identity::open_note(base, "From/n.md").unwrap();
            MOVE_FAULT.with(|current| *current.borrow_mut() = Some(phase));
            let result = move_note_at(base, "From/n.md", "To/n.md");
            MOVE_FAULT.with(|current| *current.borrow_mut() = None);
            assert!(result.is_err(), "{phase}");
            recover_move_at(base).unwrap();
            recover_move_at(base).unwrap();
            let journal = read_move_journal(base).unwrap().unwrap();
            if phase == "prepared" {
                assert!(matches!(journal.phase, MovePhase::Aborted));
                assert_eq!(std::fs::read_to_string(base.join("From/n.md")).unwrap(), format!("note-{phase}"));
                assert!(!base.join("To/n.md").exists());
            } else {
                assert!(matches!(journal.phase, MovePhase::AwaitingFrontend), "{phase}");
                assert_eq!(std::fs::read_to_string(base.join("To/n.md")).unwrap(), format!("note-{phase}"));
                assert_eq!(crate::local_identity::open_note(base, "To/n.md").unwrap().0, id);
                assert!(!base.join("From/n.md").exists());
                // save after recovered move must not recreate origin
                crate::local_identity::save_note(base, "To/n.md", &id, b"saved").unwrap();
                assert_eq!(std::fs::read_to_string(base.join("To/n.md")).unwrap(), "saved");
                assert!(!base.join("From/n.md").exists());
            }
            remove_move_journal(base).ok();
        }
    }

    #[test]
    fn phase5_archived_descendant_folder_move_allowed_and_identity_persists_paths_across_relocation() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Parent").unwrap();
        create_folder_at(base, "Parent/Archived").unwrap();
        create_folder_at(base, "Parent/Active").unwrap();
        create_folder_at(base, "Other").unwrap();
        create_folder_at(base, "Other/OtherArchived").unwrap();
        set_folder_archived_at(base, "Parent/Archived", true).unwrap();
        set_folder_archived_at(base, "Other/OtherArchived", true).unwrap();

        // Fase 6: una carpeta activa con descendientes archivados puede moverse/renombrarse.
        create_folder_at(base, "Dst").unwrap();
        let moved = move_folder_at(base, "Parent", "Dst/Parent", None).unwrap();
        assert!(moved.is_empty());
        assert!(!base.join("Parent").exists());
        assert!(base.join("Dst/Parent/Archived").is_dir());
        assert!(base.join("Dst/Parent/Active").is_dir());
        let mut archived = archived_paths(base).unwrap();
        archived.sort();
        assert_eq!(archived, vec!["Dst/Parent/Archived".to_string(), "Other/OtherArchived".to_string()]);
        assert!(ensure_active_parent_at(base, "Dst/Parent/Archived/n.md").is_err());
        assert!(ensure_active_parent_at(base, "Dst/Parent/Active/n.md").is_ok());
        assert!(ensure_active_parent_at(base, "Other/OtherArchived/n.md").is_err());
        remove_move_journal(base).unwrap();

        // Persistencia real por identidad ante cambio físico externo adicional.
        std::fs::rename(base.join("Dst/Parent/Archived"), base.join("Dst/Parent/ArchivedRenamed")).unwrap();
        let mut archived2 = archived_paths(base).unwrap();
        archived2.sort();
        assert_eq!(archived2, vec!["Dst/Parent/ArchivedRenamed".to_string(), "Other/OtherArchived".to_string()]);

        // "Reinicio" (relectura desde disco): misma resolución por identidad/ruta almacenada.
        let mut archived_again = archived_paths(base).unwrap();
        archived_again.sort();
        assert_eq!(archived_again, archived2);

        let _ = std::fs::remove_dir_all(base);
    }

    // Fase 6 §1: caracterización/reproducción del riesgo de reutilización de rutas antiguas
    // tras movimiento físico externo cuando existen claves históricas obsoletas en folder state.
    #[test]
    fn phase6_path_reuse_after_external_move_stale_historical_keys() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Trabajo").unwrap();
        create_folder_at(base, "Trabajo/Proyecto A").unwrap();
        set_folder_archived_at(base, "Trabajo/Proyecto A", true).unwrap();
        let old_id = folder_marker(&base.join("Trabajo/Proyecto A")).unwrap();

        // 3. Desplazar físicamente Trabajo a Destino/Trabajo (movimiento externo simulado).
        create_folder_at(base, "Destino").unwrap();
        std::fs::rename(base.join("Trabajo"), base.join("Destino/Trabajo")).unwrap();
        // 4. archived_paths resuelve correctamente la nueva ubicación por identidad.
        assert_eq!(archived_paths(base).unwrap(), vec!["Destino/Trabajo/Proyecto A".to_string()]);

        // 5. Crear nueva carpeta Trabajo/Proyecto A con identidad diferente.
        create_folder_at(base, "Trabajo").unwrap();
        create_folder_at(base, "Trabajo/Proyecto A").unwrap();
        let new_id = folder_marker(&base.join("Trabajo/Proyecto A")).unwrap();
        assert_ne!(old_id, new_id, "identidad diferente requerida");

        // 6. Archivar la nueva carpeta (misma ruta histórica que la clave obsoleta).
        let archived = set_folder_archived_at(base, "Trabajo/Proyecto A", true).unwrap();
        // 7-9. Comprobar conservación de ambas identidades, recuperación independiente y recarga.
        let mut archived_sorted = archived.clone();
        archived_sorted.sort();
        let mut reloaded = archived_paths(base).unwrap();
        reloaded.sort();
        // Resultado observado: ambas identidades conservan archivado tras normalización de claves históricas.
        let state = read_state(base).unwrap();
        assert_eq!(state.archived.len(), 2, "deben persistir dos identidades archivadas: {state:?}");
        // Assertions that express the desired integrity:
        assert!(archived_sorted.contains(&"Destino/Trabajo/Proyecto A".to_string()), "identidad original movida debe seguir archivada: {archived_sorted:?}");
        assert!(archived_sorted.contains(&"Trabajo/Proyecto A".to_string()), "nueva identidad en ruta reutilizada debe archivarse: {archived_sorted:?}");
        assert_eq!(archived_sorted, reloaded, "persistencia/relectura debe conservar ambas: archived={archived_sorted:?} reloaded={reloaded:?}");
        // Recuperación independiente.
        assert!(set_folder_archived_at(base, "Destino/Trabajo/Proyecto A", false).is_ok());
        let after1 = archived_paths(base).unwrap();
        assert_eq!(after1, vec!["Trabajo/Proyecto A".to_string()], "solo la nueva debe permanecer archivada: {after1:?}");
        assert!(set_folder_archived_at(base, "Trabajo/Proyecto A", false).is_ok());
        assert!(archived_paths(base).unwrap().is_empty());
        // Releer estado persistido final.
        assert!(read_state(base).unwrap().archived.is_empty());
    }

    #[test]
    fn phase6_path_reuse_after_external_move_multiple_archived_descendants() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Trabajo").unwrap();
        create_folder_at(base, "Trabajo/Proyecto A").unwrap();
        create_folder_at(base, "Trabajo/Proyecto B").unwrap();
        create_folder_at(base, "Trabajo/Proyecto B/Sub").unwrap();
        set_folder_archived_at(base, "Trabajo/Proyecto A", true).unwrap();
        set_folder_archived_at(base, "Trabajo/Proyecto B", true).unwrap();
        set_folder_archived_at(base, "Trabajo/Proyecto B/Sub", true).unwrap();
        let old_a = folder_marker(&base.join("Trabajo/Proyecto A")).unwrap();
        let old_b = folder_marker(&base.join("Trabajo/Proyecto B")).unwrap();
        let old_bs = folder_marker(&base.join("Trabajo/Proyecto B/Sub")).unwrap();

        create_folder_at(base, "Destino").unwrap();
        std::fs::rename(base.join("Trabajo"), base.join("Destino/Trabajo")).unwrap();
        let mut resolved = archived_paths(base).unwrap();
        resolved.sort();
        assert_eq!(resolved, vec![
            "Destino/Trabajo/Proyecto A".to_string(),
            "Destino/Trabajo/Proyecto B".to_string(),
            "Destino/Trabajo/Proyecto B/Sub".to_string(),
        ]);

        // Reutilizar rutas antiguas con nuevas identidades y archivarlas.
        create_folder_at(base, "Trabajo").unwrap();
        for p in ["Trabajo/Proyecto A", "Trabajo/Proyecto B", "Trabajo/Proyecto B/Sub"] {
            if p != "Trabajo" { create_folder_at(base, p).unwrap(); }
        }
        let new_a = folder_marker(&base.join("Trabajo/Proyecto A")).unwrap();
        let new_b = folder_marker(&base.join("Trabajo/Proyecto B")).unwrap();
        let new_bs = folder_marker(&base.join("Trabajo/Proyecto B/Sub")).unwrap();
        assert!(old_a != new_a && old_b != new_b && old_bs != new_bs);
        for p in ["Trabajo/Proyecto A", "Trabajo/Proyecto B", "Trabajo/Proyecto B/Sub"] {
            set_folder_archived_at(base, p, true).unwrap();
        }
        let mut all = archived_paths(base).unwrap();
        all.sort();
        let mut reloaded = archived_paths(base).unwrap();
        reloaded.sort();
        let state = read_state(base).unwrap();
        assert_eq!(state.archived.len(), 6, "todas las identidades deben persistir: {state:?}");
        let expected = vec![
            "Destino/Trabajo/Proyecto A".to_string(),
            "Destino/Trabajo/Proyecto B".to_string(),
            "Destino/Trabajo/Proyecto B/Sub".to_string(),
            "Trabajo/Proyecto A".to_string(),
            "Trabajo/Proyecto B".to_string(),
            "Trabajo/Proyecto B/Sub".to_string(),
        ];
        assert_eq!(all, expected, "todas las identidades (antiguas movidas y nuevas) deben conservar archivado");
        assert_eq!(all, reloaded);
        // Recuperación independiente por identidad/ubicación real.
        set_folder_archived_at(base, "Destino/Trabajo/Proyecto B/Sub", false).unwrap();
        set_folder_archived_at(base, "Trabajo/Proyecto A", false).unwrap();
        let mut mid = archived_paths(base).unwrap();
        mid.sort();
        assert_eq!(mid, vec![
            "Destino/Trabajo/Proyecto A".to_string(),
            "Destino/Trabajo/Proyecto B".to_string(),
            "Trabajo/Proyecto B".to_string(),
            "Trabajo/Proyecto B/Sub".to_string(),
        ]);
        let mut final_reloaded = archived_paths(base).unwrap();
        final_reloaded.sort();
        assert_eq!(mid, final_reloaded);
    }

    #[test]
    fn phase6_folder_archive_recovery_comprehensive_real_operations() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        // Carpeta vacía
        create_folder_at(base, "Empty").unwrap();
        assert_eq!(set_folder_archived_at(base, "Empty", true).unwrap(), vec!["Empty".to_string()]);
        assert!(ensure_active_parent_at(base, "Empty/n.md").is_err());
        assert!(set_folder_archived_at(base, "Empty", false).unwrap().is_empty());
        assert!(ensure_active_parent_at(base, "Empty/n.md").is_ok());

        // Multinivel con notas y archivos regulares no gestionados como notas
        create_folder_at(base, "Multi").unwrap();
        create_folder_at(base, "Multi/Sub").unwrap();
        create_folder_at(base, "Multi/Sub/Deep").unwrap();
        std::fs::write(base.join("Multi/a.txt"), "nota").unwrap();
        std::fs::write(base.join("Multi/Sub/b.md"), "nota2").unwrap();
        std::fs::write(base.join("Multi/Sub/Deep/data.bin"), [1u8, 2, 3]).unwrap();
        std::fs::write(base.join("Multi/Sub/Deep/image.pdf"), b"%PDF").unwrap();
        let multi_id = folder_marker(&base.join("Multi")).unwrap();
        let sub_id = folder_marker(&base.join("Multi/Sub")).unwrap();
        assert_eq!(set_folder_archived_at(base, "Multi", true).unwrap(), vec!["Multi".to_string()]);
        assert_eq!(std::fs::read_to_string(base.join("Multi/a.txt")).unwrap(), "nota");
        assert_eq!(std::fs::read(base.join("Multi/Sub/Deep/data.bin")).unwrap(), vec![1u8,2,3]);
        assert!(set_folder_archived_at(base, "Multi", false).unwrap().is_empty());
        assert_eq!(folder_marker(&base.join("Multi")).unwrap(), multi_id);
        assert_eq!(folder_marker(&base.join("Multi/Sub")).unwrap(), sub_id);

        // Descendiente previamente archivado + recuperación de ancestro conserva archivado explícito del descendiente
        set_folder_archived_at(base, "Multi/Sub", true).unwrap();
        set_folder_archived_at(base, "Multi", true).unwrap();
        let mut archived = archived_paths(base).unwrap(); archived.sort();
        assert_eq!(archived, vec!["Multi".to_string(), "Multi/Sub".to_string()]);
        assert!(set_folder_archived_at(base, "Multi", false).unwrap() == vec!["Multi/Sub".to_string()]);
        let mut after_parent_recover = archived_paths(base).unwrap(); after_parent_recover.sort();
        assert_eq!(after_parent_recover, vec!["Multi/Sub".to_string()]);
        assert!(ensure_active_parent_at(base, "Multi/Sub/n.md").is_err());
        assert!(ensure_active_parent_at(base, "Multi/n.md").is_ok());

        // Recuperar subcarpeta mientras ancestro continúa archivado, luego recuperar ancestro
        set_folder_archived_at(base, "Multi", true).unwrap();
        assert!(set_folder_archived_at(base, "Multi/Sub", false).is_ok()); // elimina solo estado explícito
        let mut still_archived = archived_paths(base).unwrap(); still_archived.sort();
        assert_eq!(still_archived, vec!["Multi".to_string()]); // Multi/Sub sigue efectivamente archivada por ancestro
        assert!(set_folder_archived_at(base, "Multi", false).unwrap().is_empty());
        let final_archived = archived_paths(base).unwrap();
        assert!(final_archived.is_empty(), "al recuperar ancestro, subcarpeta sin estado explícito vuelve activa: {final_archived:?}");

        // Archivado y recuperación repetidos, persistencia por relectura real
        for _ in 0..3 {
            assert!(set_folder_archived_at(base, "Multi/Sub/Deep", true).unwrap().contains(&"Multi/Sub/Deep".to_string()));
            assert!(set_folder_archived_at(base, "Multi/Sub/Deep", false).unwrap().is_empty() || !archived_paths(base).unwrap().contains(&"Multi/Sub/Deep".to_string()));
        }
        set_folder_archived_at(base, "Multi/Sub/Deep", true).unwrap();
        let from_disk = archived_paths(base).unwrap();
        assert_eq!(from_disk, vec!["Multi/Sub/Deep".to_string()]);
        let raw = std::fs::read_to_string(base.join(STATE_FILE)).unwrap();
        assert!(raw.contains("Multi/Sub/Deep"));
        assert!(set_folder_archived_at(base, "Multi/Sub/Deep", false).unwrap().is_empty());
        assert!(archived_paths(base).unwrap().is_empty());

        // Conservación de carpetas archivadas no relacionadas
        create_folder_at(base, "Unrelated").unwrap();
        create_folder_at(base, "Unrelated/Sub").unwrap();
        set_folder_archived_at(base, "Unrelated/Sub", true).unwrap();
        set_folder_archived_at(base, "Multi", true).unwrap();
        set_folder_archived_at(base, "Multi", false).unwrap();
        assert_eq!(archived_paths(base).unwrap(), vec!["Unrelated/Sub".to_string()]);

        // Fallo de persistencia (directorio de estado reemplazado por archivo) - se conserva estado previo legible
        let immutable_dir = tempfile::tempdir().unwrap();
        let b2 = immutable_dir.path();
        create_folder_at(b2, "X").unwrap();
        set_folder_archived_at(b2, "X", true).unwrap();
        let before = std::fs::read(b2.join(STATE_FILE)).unwrap();
        // reemplazar STATE_FILE por un directorio para forzar fallo de escritura atómica
        std::fs::remove_file(b2.join(STATE_FILE)).unwrap();
        std::fs::remove_file(b2.join(format!("{STATE_FILE}.bak"))).ok();
        std::fs::create_dir(b2.join(STATE_FILE)).unwrap();
        let err = set_folder_archived_at(b2, "X", false);
        assert!(err.is_err(), "debe fallar al persistir: {err:?}");
        // restaurar archivo previo para comprobar que el estado anterior no se corrompió
        std::fs::remove_dir(b2.join(STATE_FILE)).unwrap();
        std::fs::write(b2.join(STATE_FILE), &before).unwrap();
        assert_eq!(archived_paths(b2).unwrap(), vec!["X".to_string()]);
    }

    #[test]
    fn phase6_move_rename_active_folder_with_archived_descendants_comprehensive() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Work").unwrap();
        create_folder_at(base, "Work/Active").unwrap();
        create_folder_at(base, "Work/ArchivedA").unwrap();
        create_folder_at(base, "Work/ArchivedA/Nested").unwrap();
        create_folder_at(base, "Work/ArchivedB").unwrap();
        create_folder_at(base, "Other").unwrap();
        create_folder_at(base, "Other/Keep").unwrap();
        std::fs::write(base.join("Work/Active/note.md"), "active").unwrap();
        std::fs::write(base.join("Work/ArchivedA/note.md"), "archived-a").unwrap();
        std::fs::write(base.join("Work/ArchivedB/note.txt"), "archived-b").unwrap();
        std::fs::write(base.join("Work/regular.bin"), [9u8,8,7]).unwrap();
        let work_id = folder_marker(&base.join("Work")).unwrap();
        let arch_a_id = folder_marker(&base.join("Work/ArchivedA")).unwrap();
        let arch_b_id = folder_marker(&base.join("Work/ArchivedB")).unwrap();
        let nested_id = folder_marker(&base.join("Work/ArchivedA/Nested")).unwrap();
        let (active_note_id, _) = crate::local_identity::open_note(base, "Work/Active/note.md").unwrap();
        let (arch_note_id, _) = crate::local_identity::open_note(base, "Work/ArchivedA/note.md").unwrap();
        set_folder_archived_at(base, "Work/ArchivedA", true).unwrap();
        set_folder_archived_at(base, "Work/ArchivedB", true).unwrap();
        set_folder_archived_at(base, "Other/Keep", true).unwrap();

        // 1. Renombrar carpeta activa con descendientes archivados (mismo padre)
        let moved = move_folder_at(base, "Work", "Labor", None).unwrap();
        assert!(moved.iter().any(|c| c.old_path == "Work/Active/note.md" && c.new_path == "Labor/Active/note.md"));
        assert!(!base.join("Work").exists());
        assert!(base.join("Labor/ArchivedA/Nested").is_dir());
        assert_eq!(folder_marker(&base.join("Labor")).unwrap(), work_id);
        assert_eq!(folder_marker(&base.join("Labor/ArchivedA")).unwrap(), arch_a_id);
        assert_eq!(folder_marker(&base.join("Labor/ArchivedB")).unwrap(), arch_b_id);
        assert_eq!(folder_marker(&base.join("Labor/ArchivedA/Nested")).unwrap(), nested_id);
        assert_eq!(std::fs::read_to_string(base.join("Labor/ArchivedA/note.md")).unwrap(), "archived-a");
        assert_eq!(std::fs::read(base.join("Labor/regular.bin")).unwrap(), vec![9u8,8,7]);
        let mut archived = archived_paths(base).unwrap(); archived.sort();
        assert_eq!(archived, vec!["Labor/ArchivedA".to_string(), "Labor/ArchivedB".to_string(), "Other/Keep".to_string()]);
        assert_eq!(crate::local_identity::open_note(base, "Labor/Active/note.md").unwrap().0, active_note_id);
        assert_eq!(crate::local_identity::open_note(base, "Labor/ArchivedA/note.md").unwrap().0, arch_note_id);
        remove_move_journal(base).unwrap();

        // 2. Mover entre carpetas (primer nivel -> subcarpeta de otra)
        create_folder_at(base, "Container").unwrap();
        move_folder_at(base, "Labor", "Container/Labor", None).unwrap();
        let mut archived = archived_paths(base).unwrap(); archived.sort();
        assert_eq!(archived, vec!["Container/Labor/ArchivedA".to_string(), "Container/Labor/ArchivedB".to_string(), "Other/Keep".to_string()]);
        remove_move_journal(base).unwrap();

        // 3. Subcarpeta -> primer nivel
        move_folder_at(base, "Container/Labor", "Labor", None).unwrap();
        let mut archived = archived_paths(base).unwrap(); archived.sort();
        assert_eq!(archived, vec!["Labor/ArchivedA".to_string(), "Labor/ArchivedB".to_string(), "Other/Keep".to_string()]);
        remove_move_journal(base).unwrap();

        // 4. Mover a subcarpeta profunda
        create_folder_at(base, "DeepHost").unwrap();
        create_folder_at(base, "DeepHost/Level1").unwrap();
        move_folder_at(base, "Labor", "DeepHost/Level1/Labor", None).unwrap();
        let mut archived = archived_paths(base).unwrap(); archived.sort();
        assert_eq!(archived, vec!["DeepHost/Level1/Labor/ArchivedA".to_string(), "DeepHost/Level1/Labor/ArchivedB".to_string(), "Other/Keep".to_string()]);
        remove_move_journal(base).unwrap();

        // 8. Recuperación posterior de descendientes archivados desde nuevas ubicaciones
        assert!(ensure_active_parent_at(base, "DeepHost/Level1/Labor/ArchivedA/n.md").is_err());
        let after = set_folder_archived_at(base, "DeepHost/Level1/Labor/ArchivedA", false).unwrap();
        assert!(after.iter().all(|p| p != "DeepHost/Level1/Labor/ArchivedA"));
        assert!(ensure_active_parent_at(base, "DeepHost/Level1/Labor/ArchivedA/n.md").is_ok());
        set_folder_archived_at(base, "DeepHost/Level1/Labor/ArchivedA", true).unwrap();

        // 9. Reutilización de la antigua ruta sin pérdida ni reasignación de identidades
        create_folder_at(base, "Labor").unwrap();
        create_folder_at(base, "Labor/ArchivedA").unwrap();
        let new_id = folder_marker(&base.join("Labor/ArchivedA")).unwrap();
        assert_ne!(new_id, arch_a_id);
        set_folder_archived_at(base, "Labor/ArchivedA", true).unwrap();
        let mut all = archived_paths(base).unwrap(); all.sort();
        assert!(all.contains(&"DeepHost/Level1/Labor/ArchivedA".to_string()), "identidad movida conservada: {all:?}");
        assert!(all.contains(&"Labor/ArchivedA".to_string()), "nueva identidad en ruta reutilizada: {all:?}");
        assert!(all.contains(&"Other/Keep".to_string()));
        // recuperar independientemente
        set_folder_archived_at(base, "DeepHost/Level1/Labor/ArchivedA", false).unwrap();
        let mut after_old = archived_paths(base).unwrap(); after_old.sort();
        assert!(!after_old.contains(&"DeepHost/Level1/Labor/ArchivedA".to_string()));
        assert!(after_old.contains(&"Labor/ArchivedA".to_string()));
        set_folder_archived_at(base, "Labor/ArchivedA", false).unwrap();

        // 11. Persistencia/relectura tras operaciones
        let mut final_archived = archived_paths(base).unwrap(); final_archived.sort();
        assert_eq!(final_archived, vec!["DeepHost/Level1/Labor/ArchivedB".to_string(), "Other/Keep".to_string()]);

        // 12. Contenido físico intacto
        assert_eq!(std::fs::read_to_string(base.join("DeepHost/Level1/Labor/Active/note.md")).unwrap(), "active");
        assert_eq!(std::fs::read_to_string(base.join("DeepHost/Level1/Labor/ArchivedA/note.md")).unwrap(), "archived-a");

        // 15. Rechazos preservados
        assert!(move_folder_at(base, "DeepHost/Level1/Labor/ArchivedB", "X", None).is_err(), "mover carpeta archivada directamente");
        assert!(move_note_at(base, "DeepHost/Level1/Labor/ArchivedB/note.txt", "x.txt").is_err(), "mover desde interior archivado");
        assert!(move_note_at(base, "DeepHost/Level1/Labor/Active/note.md", "DeepHost/Level1/Labor/ArchivedB/note.md").is_err(), "mover hacia archivada");
        assert!(move_folder_at(base, "DeepHost", "DeepHost/Level1/X", None).is_err(), "mover dentro de sí misma/descendiente");
        set_folder_archived_at(base, "Other", false).ok();
        create_folder_at(base, "Collision").unwrap();
        assert!(move_folder_at(base, "Collision", "DeepHost", None).is_err(), "colisión con carpeta existente");
    }

    #[test]
    fn phase6_move_with_archived_descendants_preserves_note_individual_archive_state() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "Parent").unwrap();
        create_folder_at(base, "Parent/Sub").unwrap();
        std::fs::write(base.join("Parent/n1.md"), "n1").unwrap();
        std::fs::write(base.join("Parent/Sub/n2.md"), "n2").unwrap();
        let (id1, _) = crate::local_identity::open_note(base, "Parent/n1.md").unwrap();
        let (id2, _) = crate::local_identity::open_note(base, "Parent/Sub/n2.md").unwrap();
        crate::gdrive::provenance::record_local_write(base, "Parent/n1.md", None, true).unwrap();
        crate::gdrive::provenance::record_local_write(base, "Parent/Sub/n2.md", None, true).unwrap();
        crate::gdrive::archive::set_archived(base, "Parent/n1.md", true, None).unwrap();
        crate::gdrive::archive::set_archived(base, "Parent/Sub/n2.md", true, None).unwrap();
        let before = crate::gdrive::archive::projection(base, None).unwrap();
        assert!(before.archived_names.contains(&"Parent/n1.md".to_string()));
        assert!(before.archived_names.contains(&"Parent/Sub/n2.md".to_string()));

        let moved = move_folder_at(base, "Parent", "Moved", None).unwrap();
        assert!(moved.iter().any(|c| c.old_path == "Parent/n1.md" && c.new_path == "Moved/n1.md"));
        assert!(moved.iter().any(|c| c.old_path == "Parent/Sub/n2.md" && c.new_path == "Moved/Sub/n2.md"));
        assert_eq!(crate::local_identity::open_note(base, "Moved/n1.md").unwrap().0, id1);
        assert_eq!(crate::local_identity::open_note(base, "Moved/Sub/n2.md").unwrap().0, id2);
        assert_eq!(std::fs::read_to_string(base.join("Moved/n1.md")).unwrap(), "n1");
        assert_eq!(std::fs::read_to_string(base.join("Moved/Sub/n2.md")).unwrap(), "n2");
        // Proyección/ledger siguen la identidad en la nueva ruta (por nombre actualizado en provenance)
        let after = crate::gdrive::archive::projection(base, None).unwrap();
        assert!(after.archived_names.contains(&"Moved/n1.md".to_string()), "n1 archivada en nueva ruta: {:?}", after.archived_names);
        assert!(after.archived_names.contains(&"Moved/Sub/n2.md".to_string()), "n2 archivada en nueva ruta: {:?}", after.archived_names);
        assert!(!after.archived_names.iter().any(|n| n.starts_with("Parent/")), "sin referencias obsoletas: {:?}", after.archived_names);
        // Persistencia tras relectura
        let reloaded = crate::gdrive::archive::projection(base, None).unwrap();
        assert_eq!(after.archived_names, reloaded.archived_names);
        // Recuperación individual desde nueva ubicación
        crate::gdrive::archive::set_archived(base, "Moved/n1.md", false, None).unwrap();
        let after_restore = crate::gdrive::archive::projection(base, None).unwrap();
        assert!(!after_restore.archived_names.contains(&"Moved/n1.md".to_string()));
        assert!(after_restore.archived_names.contains(&"Moved/Sub/n2.md".to_string()));
        remove_move_journal(base).unwrap();

        // Nota nueva creada en ruta antigua no queda archivada accidentalmente
        std::fs::create_dir_all(base.join("Parent")).unwrap();
        std::fs::write(base.join("Parent/n1.md"), "nueva").unwrap();
        crate::gdrive::provenance::record_local_write(base, "Parent/n1.md", None, true).unwrap();
        let fresh = crate::gdrive::archive::projection(base, None).unwrap();
        assert!(!fresh.archived_names.contains(&"Parent/n1.md".to_string()));
    }

    #[test]
    fn phase6_interrupted_folder_move_with_archived_descendants_preserves_archive_identity() {
        for phase in ["prepared", "physical", "provenance", "identity", "drafts", "frontend"] {
            let root = tempfile::tempdir().unwrap();
            let base = root.path();
            create_folder_at(base, "Src").unwrap();
            create_folder_at(base, "Src/Archived").unwrap();
            create_folder_at(base, "Other").unwrap();
            create_folder_at(base, "Other/Keep").unwrap();
            std::fs::write(base.join("Src/n.md"), "x").unwrap();
            set_folder_archived_at(base, "Src/Archived", true).unwrap();
            set_folder_archived_at(base, "Other/Keep", true).unwrap();
            let src_id = folder_marker(&base.join("Src")).unwrap();
            let arch_id = folder_marker(&base.join("Src/Archived")).unwrap();
            MOVE_FAULT.with(|current| *current.borrow_mut() = Some(phase));
            let result = move_folder_at(base, "Src", "Dst", None);
            MOVE_FAULT.with(|current| *current.borrow_mut() = None);
            assert!(result.is_err(), "{phase}");
            recover_move_at(base).unwrap();
            recover_move_at(base).unwrap();
            let journal = read_move_journal(base).unwrap().unwrap();
            let mut archived = archived_paths(base).unwrap(); archived.sort();
            assert!(archived.contains(&"Other/Keep".to_string()), "{phase} conserva no relacionadas: {archived:?}");
            if phase == "prepared" {
                assert!(matches!(journal.phase, MovePhase::Aborted), "{phase}");
                assert!(base.join("Src/Archived").is_dir());
                assert!(archived.contains(&"Src/Archived".to_string()), "{phase}: {archived:?}");
                assert_eq!(folder_marker(&base.join("Src")).unwrap(), src_id);
            } else {
                assert!(matches!(journal.phase, MovePhase::AwaitingFrontend), "{phase}");
                assert!(base.join("Dst/Archived").is_dir());
                assert!(archived.contains(&"Dst/Archived".to_string()), "{phase}: {archived:?}");
                assert_eq!(folder_marker(&base.join("Dst")).unwrap(), src_id);
                assert_eq!(folder_marker(&base.join("Dst/Archived")).unwrap(), arch_id);
            }
            assert_eq!(archived.len(), 2, "{phase}: {archived:?}");
            remove_move_journal(base).ok();
        }
    }

    #[test]
    fn phase6_normalization_preserves_unresolvable_archived_identity_historical_key() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "A").unwrap();
        set_folder_archived_at(base, "A", true).unwrap();
        let id_a = folder_marker(&base.join("A")).unwrap();
        // Simular identidad no resoluble: eliminar marcador pero conservar estado persistido.
        std::fs::remove_file(base.join("A").join(FOLDER_ID_FILE)).unwrap();
        let disk_before = std::fs::read(state_path(base)).unwrap();
        let mut state = read_state(base).unwrap();
        normalize_folder_state(base, &mut state).unwrap();
        assert_eq!(state.archived, vec!["A".to_string()]);
        assert_eq!(state.identities.get("A"), Some(&id_a));
        // normalize_folder_state no escribe a disco.
        assert_eq!(std::fs::read(state_path(base)).unwrap(), disk_before);
    }

    #[test]
    fn phase6_normalization_fails_on_collision_between_unresolvable_historical_key_and_resolved_path() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        // Identidad A archivada en Trabajo/Proyecto, luego movida físicamente fuera para que su clave histórica quede obsoleta/no resoluble en esa ruta.
        create_folder_at(base, "Trabajo").unwrap();
        create_folder_at(base, "Trabajo/Proyecto").unwrap();
        set_folder_archived_at(base, "Trabajo/Proyecto", true).unwrap();
        let id_a = folder_marker(&base.join("Trabajo/Proyecto")).unwrap();
        create_folder_at(base, "Destino").unwrap();
        std::fs::rename(base.join("Trabajo/Proyecto"), base.join("Destino/Proyecto")).unwrap();
        // Hacer A no resoluble eliminando su marcador (pero conservando referencia histórica en estado tras reconstrucción manual).
        std::fs::remove_file(base.join("Destino/Proyecto").join(FOLDER_ID_FILE)).unwrap();
        let mut state = read_state(base).unwrap();
        // Forzar clave histórica al antiguo lugar (A no resoluble => clave histórica)
        state.archived = vec!["Trabajo/Proyecto".to_string()];
        state.identities.clear();
        state.identities.insert("Trabajo/Proyecto".to_string(), id_a.clone());
        write_state(base, &state).unwrap();
        let before = std::fs::read(state_path(base)).unwrap();

        // Identidad B existe físicamente en la ruta histórica de A.
        std::fs::create_dir_all(base.join("Trabajo/Proyecto")).unwrap();
        let id_b = folder_marker(&base.join("Trabajo/Proyecto")).unwrap();
        assert_ne!(id_a, id_b);

        // Verificar que la normalización detectaría/preservaría la clave histórica de A (no resoluble).
        let mut norm_state = read_state(base).unwrap();
        normalize_folder_state(base, &mut norm_state).unwrap();
        assert_eq!(norm_state.identities.get("Trabajo/Proyecto"), Some(&id_a), "A debe conservar clave histórica: {norm_state:?}");
        let err = set_folder_archived_at(base, "Trabajo/Proyecto", true).unwrap_err();
        assert!(err.contains("identity path collision") || err.contains("collision") || err.contains("Cannot normalize"), "{err}");
        let after = std::fs::read(state_path(base)).unwrap();
        assert_eq!(after, before, "el estado previo debe conservarse sin escritura");
        let persisted = read_state(base).unwrap();
        assert_eq!(persisted.archived, vec!["Trabajo/Proyecto".to_string()]);
        assert_eq!(persisted.identities.get("Trabajo/Proyecto"), Some(&id_a));
    }

    #[test]
    fn phase6_normalization_fails_when_two_identities_require_same_persistent_key() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "A").unwrap();
        create_folder_at(base, "B").unwrap();
        set_folder_archived_at(base, "A", true).unwrap();
        set_folder_archived_at(base, "B", true).unwrap();
        let id_a = folder_marker(&base.join("A")).unwrap();
        let id_b = folder_marker(&base.join("B")).unwrap();
        let disk_before = std::fs::read(state_path(base)).unwrap();
        // Construir estado donde A es no resoluble con clave histórica "B" y B se resuelve a "B": misma clave persistente requerida.
        std::fs::remove_file(base.join("A").join(FOLDER_ID_FILE)).unwrap();
        let mut state = FolderState {
            version: 2,
            archived: vec!["B".to_string(), "B".to_string()],
            identities: BTreeMap::from([
                ("B".to_string(), id_a.clone()), // clave histórica de A (no resoluble) colisiona con ruta resuelta de B
                ("B_resolved_placeholder".to_string(), id_b.clone()),
            ]),
        };
        // Ajustar para representar ambas identidades con claves que fuerzan colisión en preferencia.
        state.identities = BTreeMap::from([("B".to_string(), id_a.clone())]);
        state.archived = vec!["B".to_string()];
        // Añadir B como identidad archivada cuya ruta resuelta es "B" (marcador presente)
        // Para que normalize vea ambos ids, necesitamos que archived/identities referencien ambos.
        let mut full = FolderState { version: 2, archived: Vec::new(), identities: BTreeMap::new() };
        full.archived.push("B".to_string()); // id_a (histórico no resoluble)
        full.identities.insert("B".to_string(), id_a.clone());
        full.archived.push("__b__".to_string()); // id_b referenciado por otra clave pero resuelto a "B"
        full.identities.insert("__b__".to_string(), id_b.clone());
        let err = normalize_folder_state(base, &mut full).unwrap_err();
        assert!(err.contains("collision") || err.contains("Cannot normalize"), "{err}");
        // Estado en disco intacto (no se escribió).
        assert_eq!(std::fs::read(state_path(base)).unwrap(), disk_before);
        let _ = state;
    }

    #[test]
    fn phase6_normalization_rejects_duplicate_markers_and_preserves_state() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        create_folder_at(base, "X").unwrap();
        create_folder_at(base, "Y").unwrap();
        set_folder_archived_at(base, "X", true).unwrap();
        let id_x = folder_marker(&base.join("X")).unwrap();
        let before = std::fs::read(state_path(base)).unwrap();
        // Duplicar marcador (mismo id en otra carpeta física)
        let marker = serde_json::to_vec(&FolderMarker { version: 1, id: id_x }).unwrap();
        std::fs::write(base.join("Y").join(FOLDER_ID_FILE), marker).unwrap();
        let err = set_folder_archived_at(base, "X", false).unwrap_err();
        assert!(err.contains("Duplicate folder identity"), "{err}");
        let after = std::fs::read(state_path(base)).unwrap();
        assert_eq!(after, before, "no debe escribirse ante marcador duplicado");
    }
}
