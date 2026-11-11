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

#[derive(Clone, Serialize, Deserialize)]
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

#[derive(Default, Serialize, Deserialize)]
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
    for old_path in &state.archived {
        let id = state.identities.get(old_path).ok_or("Archived folder has no stable identity")?;
        let current = found.get(id).ok_or("Archived folder identity is missing; no other folder was archived")?;
        paths.push(current.clone());
    }
    paths.sort();
    Ok(paths)
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

fn ensure_notes_not_bound(base: &Path, notes: &[PathChange]) -> Result<(), String> {
    let ledger_path = crate::gdrive::provenance::get_ledger_path(base);
    if let Some(ledger) = crate::gdrive::provenance::load_ledger(&ledger_path)? {
        for change in notes {
            if ledger.by_name.get(&change.old_path)
                .and_then(|id| ledger.notes.get(id))
                .is_some_and(|note| note.bindings.values().any(|binding| binding.drive_id.is_some()
                    || binding.state == crate::gdrive::provenance::AccountLinkState::Authorized)) {
                return Err(format!("{} is linked to Google Drive and cannot be moved locally", change.old_path));
            }
        }
    }
    for entry in std::fs::read_dir(base).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !(name == ".gdrive_manifest.json" || name == ".gdrive_manifest.json.bak"
            || name.starts_with(".gdrive_manifest_") && (name.ends_with(".json") || name.ends_with(".json.bak"))) { continue; }
        let raw = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        let manifest: crate::gdrive::types::SyncManifest = serde_json::from_str(&raw)
            .map_err(|e| format!("Cannot verify Drive manifest before move: {e}"))?;
        if notes.iter().any(|change| manifest.files.contains_key(&change.old_path)) {
            return Err("A note is registered in Google Drive and cannot be moved locally".into());
        }
    }
    Ok(())
}

fn validate_move_state(base: &Path, source: &str, destination: &str) -> Result<(), String> {
    if archived_paths(base)?.iter().any(|path| source == path || source.starts_with(&format!("{path}/"))
        || path.starts_with(&format!("{source}/")) || destination == path
        || destination.starts_with(&format!("{path}/"))) {
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
    let source = folder_path(base, source_path)?;
    let destination = folder_path(base, destination_path)?;
    if !source.is_dir() { return Err("La carpeta de origen no existe".into()); }
    if destination.exists() { return Err("El destino ya existe".into()); }
    if !destination.parent().is_some_and(Path::is_dir) { return Err("La carpeta de destino no existe".into()); }
    let folder_id = folder_marker(&source)?;
    validate_move_state(base, source_path, destination_path)?;
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
    validate_move_state(base, source_path, destination_path)?;
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
    let id = folder_marker(&target)?;
    state.version = 2;
    state.archived.retain(|path| state.identities.get(path) != Some(&id));
    if archived {
        state.identities.insert(relative_path.to_string(), id);
        state.archived.push(relative_path.to_string());
    } else {
        state.identities.retain(|_, value| value != &id);
    }
    state.archived.sort();
    write_state(base, &state)?;
    archived_paths(base)
}

fn create_folder_at(base: &Path, relative_path: &str) -> Result<(), String> {
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
}
