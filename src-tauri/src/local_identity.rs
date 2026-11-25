//! Local, path-independent note identities. Anchors are hard links kept under
//! Lyra's hidden metadata directory, so a retired file ID cannot be reused
//! while its logical identity is live.
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

const DIR: &str = ".lyra_local_identity";
const REGISTRY: &str = "registry.json";

#[cfg(test)]
thread_local! { static SAVE_BEFORE_EXCHANGE: std::cell::RefCell<Option<fn(&Path)>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
thread_local! { static SAVE_RESCUE_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

fn before_exchange(_target: &Path) {
    #[cfg(test)]
    SAVE_BEFORE_EXCHANGE.with(|hook| {
        if let Some(run) = hook.borrow_mut().take() { run(_target); }
    });
}

#[derive(Clone, Serialize, Deserialize)]
struct NoteIdentity { id: String, anchor: String }

#[derive(Serialize, Deserialize)]
struct Registry {
    version: u32,
    notes: BTreeMap<String, NoteIdentity>,
    #[serde(default)]
    retired: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct SaveJournal {
    version: u32,
    name: String,
    id: String,
    temp: String,
    backup: String,
    new_anchor: String,
    old_anchor: String,
    old_physical: String,
    new_physical: String,
    #[serde(default)]
    expected_old_hash: Option<String>,
}

pub(crate) fn content_sha256(content: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(content))
}

fn hash_regular(path: &Path) -> Result<String, String> {
    let mut file = open_regular(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| format!("Cannot read note version: {e}"))?;
    Ok(content_sha256(&bytes))
}

impl Default for Registry {
    fn default() -> Self { Self { version: 1, notes: BTreeMap::new(), retired: BTreeMap::new() } }
}

fn metadata_dir(base: &Path) -> Result<PathBuf, String> {
    let dir = base.join(DIR);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(dir),
        Ok(_) => Err("Local identity metadata directory is unsafe".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&dir).map_err(|e| format!("Cannot create local identity directory: {e}"))?;
            Ok(dir)
        }
        Err(error) => Err(format!("Cannot read local identity directory: {error}")),
    }
}

fn parse_registry(raw: &[u8]) -> Result<Registry, String> {
    let registry: Registry = serde_json::from_slice(raw).map_err(|e| format!("Invalid local identity registry: {e}"))?;
    if registry.version != 1 { return Err("Unsupported local identity registry version".into()); }
    if registry.notes.values().any(|note| note.id.len() != 32
        || !note.id.bytes().all(|b| b.is_ascii_hexdigit())
        || !(note.anchor == format!("{}.anchor", note.id)
            || note.anchor.starts_with(&format!("{}.", note.id)) && note.anchor.ends_with(".new")
                && !note.anchor.contains('/') && !note.anchor.contains('\\'))) {
        return Err("Invalid local identity registry entry".into());
    }
    Ok(registry)
}

fn read_registry(base: &Path) -> Result<Registry, String> {
    let dir = metadata_dir(base)?;
    let primary = dir.join(REGISTRY);
    let backup = dir.join("registry.json.bak");
    match fs::read(&primary) {
        Ok(raw) => parse_registry(&raw).or_else(|primary_error| {
            let raw = fs::read(&backup).map_err(|_| primary_error)?;
            parse_registry(&raw)
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match fs::read(&backup) {
            Ok(raw) => parse_registry(&raw),
            Err(backup_error) if backup_error.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
            Err(backup_error) => Err(format!("Cannot read local identity backup: {backup_error}")),
        },
        Err(error) => Err(format!("Cannot read local identity registry: {error}")),
    }
}

fn write_registry(base: &Path, registry: &Registry) -> Result<(), String> {
    let dir = metadata_dir(base)?;
    let primary = dir.join(REGISTRY);
    if let Ok(raw) = fs::read(&primary) {
        if parse_registry(&raw).is_ok() {
            crate::gdrive::sync::write_file_atomic(&dir.join("registry.json.bak"), &raw)
                .map_err(|e| format!("Cannot back up local identities: {e}"))?;
        }
    }
    let raw = serde_json::to_vec(registry).map_err(|e| e.to_string())?;
    crate::gdrive::sync::write_file_atomic(&primary, &raw)
        .map_err(|e| format!("Cannot save local identities: {e}"))
}

#[cfg(unix)]
fn physical_id(file: &File) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    Ok(format!("{}:{}", meta.dev(), meta.ino()))
}

#[cfg(windows)]
pub(crate) fn physical_id(file: &File) -> Result<String, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandleEx, FileIdInfo, FILE_ID_INFO};
    let mut info = FILE_ID_INFO::default();
    let ok = unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), FileIdInfo,
        (&mut info as *mut FILE_ID_INFO).cast(), std::mem::size_of::<FILE_ID_INFO>() as u32) };
    if ok == 0 || info.FileId.Identifier.iter().all(|byte| *byte == 0) {
        return Err("This Windows volume does not provide a verifiable 128-bit file ID".into());
    }
    Ok(format!("{}:{:02x?}", info.VolumeSerialNumber, info.FileId.Identifier))
}

fn open_regular(path: &Path) -> Result<File, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect note identity: {e}"))?;
    if !meta.file_type().is_file() { return Err("Note path is no longer a regular file".into()); }
    let file = File::open(path).map_err(|e| format!("Cannot open note identity: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Note identity is not a regular file".into()); }
    Ok(file)
}

pub(crate) fn physical_id_at_path(path: &Path) -> Result<String, String> {
    physical_id(&open_regular(path)?)
}

pub(crate) fn registered_note_id(base: &Path, name: &str) -> Result<Option<String>, String> {
    Ok(read_registry(base)?.notes.get(name).map(|note| note.id.clone()))
}

pub(crate) fn verified_note_id(base: &Path, name: &str) -> Result<Option<String>, String> {
    let registry = read_registry(base)?;
    let Some(note) = registry.notes.get(name) else { return Ok(None) };
    let path = crate::gdrive::sync::resolve_safe_path(base, name)?;
    let anchor = metadata_dir(base)?.join(&note.anchor);
    Ok(same_physical(&path, &anchor)?.then(|| note.id.clone()))
}

pub(crate) fn retire_deleted_note_if_id(base: &Path, name: &str, expected_id: &str) -> Result<(), String> {
    let mut registry = read_registry(base)?;
    let Some(note) = registry.notes.get(name) else { return Ok(()); };
    if note.id != expected_id { return Ok(()); }
    let anchor = metadata_dir(base)?.join(&note.anchor);
    registry.notes.remove(name);
    registry.retired.insert(name.to_string(), expected_id.to_string());
    write_registry(base, &registry)?;
    match fs::remove_file(anchor) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot clear deleted note anchor: {error}")),
    }
}

pub(crate) fn same_physical(a: &Path, b: &Path) -> Result<bool, String> {
    let first = open_regular(a)?;
    let second = open_regular(b)?;
    Ok(physical_id(&first)? == physical_id(&second)?)
}

fn journal_path(base: &Path) -> Result<PathBuf, String> { Ok(metadata_dir(base)?.join("save-journal.json")) }

fn read_journal(base: &Path) -> Result<Option<SaveJournal>, String> {
    match fs::read(journal_path(base)?) {
        Ok(raw) => parse_save_journal(&raw).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read local save journal: {error}")),
    }
}

fn parse_save_journal(raw: &[u8]) -> Result<SaveJournal, String> {
    let journal: SaveJournal = serde_json::from_slice(raw).map_err(|e| format!("Invalid local save journal: {e}"))?;
    if journal.version != 1 || journal.id.is_empty() || journal.temp.contains('/') || journal.backup.contains('/')
        || journal.new_anchor.contains('/') || journal.old_anchor.contains('/') || journal.temp.contains('\\')
        || journal.backup.contains('\\') || journal.new_anchor.contains('\\') || journal.old_anchor.contains('\\') {
        return Err("Invalid local save journal fields".into());
    }
    Ok(journal)
}

fn write_journal(base: &Path, journal: &SaveJournal) -> Result<(), String> {
    let raw = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    crate::gdrive::sync::write_file_atomic(&journal_path(base)?, &raw)
        .map_err(|e| format!("Cannot prepare local save: {e}"))
}

#[cfg(target_os = "linux")]
fn exchange(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    use std::ffi::CString;
    let parent = File::open(target.parent().ok_or("Invalid save parent")?).map_err(|e| e.to_string())?;
    let temp_name = CString::new(temp.file_name().ok_or("Invalid save temp")?.as_encoded_bytes()).map_err(|e| e.to_string())?;
    let target_name = CString::new(target.file_name().ok_or("Invalid save target")?.as_encoded_bytes()).map_err(|e| e.to_string())?;
    let result = unsafe { libc::renameat2(parent.as_raw_fd(), temp_name.as_ptr(), parent.as_raw_fd(), target_name.as_ptr(), libc::RENAME_EXCHANGE) };
    if result != 0 { return Err(format!("Atomic exchange is unavailable on this volume: {}", std::io::Error::last_os_error())); }
    Ok(())
}

#[cfg(windows)]
fn exchange(temp: &Path, target: &Path, backup: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |path: &Path| path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let target_w = wide(target);
    let temp_w = wide(temp);
    let backup_w = wide(backup);
    let result = unsafe { ReplaceFileW(target_w.as_ptr(), temp_w.as_ptr(), backup_w.as_ptr(), 0, std::ptr::null(), std::ptr::null()) };
    if result == 0 { return Err(format!("Atomic replacement is unavailable on this volume: {}", std::io::Error::last_os_error())); }
    Ok(())
}

fn recover_save_inner(base: &Path) -> Result<(), String> {
    let Some(journal) = read_journal(base)? else { return Ok(()); };
    let target = crate::gdrive::sync::resolve_safe_path(base, &journal.name)?;
    let mut registry = read_registry(base)?;
    let note = registry.notes.get(&journal.name).ok_or("Save recovery requires a registered note")?;
    if note.id != journal.id { return Err("Save recovery identity conflict".into()); }
    if note.anchor != journal.old_anchor && note.anchor != journal.new_anchor { return Err("Save recovery anchor conflict".into()); }
    let dir = metadata_dir(base)?;
    let old_anchor = dir.join(&journal.old_anchor);
    let new_anchor = dir.join(&journal.new_anchor);
    let parent = target.parent().ok_or("Invalid save parent")?;
    let temp = parent.join(&journal.temp);
    let backup = parent.join(&journal.backup);

    let target_id = if target.exists() { Some(physical_id(&open_regular(&target)?)?) } else { None };
    let target_is_new = target_id.as_deref() == Some(&journal.new_physical);
    let target_is_old = target_id.as_deref() == Some(&journal.old_physical);
    let displaced = if cfg!(windows) { &backup } else { &temp };
    if note.anchor == journal.new_anchor && target_is_new && new_anchor.exists() && same_physical(&target, &new_anchor)? {
        if displaced.exists() { fs::remove_file(displaced).map_err(|e| format!("Cannot clear verified save backup: {e}"))?; }
        if old_anchor.exists() { fs::remove_file(&old_anchor).map_err(|e| format!("Cannot clear old note anchor: {e}"))?; }
        fs::remove_file(journal_path(base)?).map_err(|e| format!("Cannot clear save journal: {e}"))?;
        return Ok(());
    }
    if target_is_old && temp.exists() && same_physical(&temp, &new_anchor)? {
        let expected_hash = journal.expected_old_hash.as_ref().ok_or("Legacy save journal lacks a verifiable content version; manual recovery required")?;
        if hash_regular(&old_anchor)? != *expected_hash {
            return Err("Note content changed externally during save; pending edit and physical content were retained".into());
        }
        before_exchange(&target);
        #[cfg(target_os = "linux")]
        exchange(&temp, &target)?;
        #[cfg(windows)]
        exchange(&temp, &target, &backup)?;
        #[cfg(not(any(target_os = "linux", windows)))]
        return Err("Atomic guarded save is unsupported on this platform".into());
    } else if !target_is_new {
        return Err("Save recovery is ambiguous; all files and drafts were retained".into());
    }
    if !new_anchor.exists() || !same_physical(&target, &new_anchor)? {
        return Err("Save destination changed externally; all files and drafts were retained".into());
    }
    if !displaced.exists() || !same_physical(displaced, &old_anchor)? {
        return Err("Displaced file identity is ambiguous; backup and draft were retained".into());
    }
    let expected_hash = journal.expected_old_hash.as_ref().ok_or("Legacy save journal lacks a verifiable content version; backup retained for manual recovery")?;
    if hash_regular(displaced)? != *expected_hash {
        // The old file changed after the pre-exchange check. Restore it to
        // the public path and keep the new editor bytes in the staging file.
        #[cfg(target_os = "linux")]
        exchange(&temp, &target)?;
        #[cfg(windows)]
        exchange(&backup, &target, &temp)?;
        return Err("Note changed during save; external content restored and editor bytes retained for recovery".into());
    }
    if !same_physical(&target, &new_anchor)? {
        return Err("Final note identity verification failed; backup and draft were retained".into());
    }
    registry.notes.get_mut(&journal.name).ok_or("Missing note identity")?.anchor = journal.new_anchor.clone();
    write_registry(base, &registry)?;
    fs::remove_file(displaced).map_err(|e| format!("Cannot clear verified save backup: {e}"))?;
    fs::remove_file(&old_anchor).map_err(|e| format!("Cannot clear old note anchor: {e}"))?;
    fs::remove_file(journal_path(base)?).map_err(|e| format!("Cannot clear save journal: {e}"))?;
    Ok(())
}

fn copy_rescue(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(test)]
    if SAVE_RESCUE_FAILURE.with(std::cell::Cell::get) {
        return Err("Injected rescue storage failure".into());
    }
    let before = hash_regular(source)?;
    if destination.exists() {
        if hash_regular(destination)? == before { return Ok(()); }
        return Err("Recovery copy differs from its source; both versions were retained".into());
    }
    let mut input = open_regular(source)?;
    let temp = destination.with_file_name(format!(".lyra_recovery_copy_{:032x}.tmp", rand::random::<u128>()));
    let mut output = OpenOptions::new().write(true).create_new(true).open(&temp)
        .map_err(|e| format!("Cannot create independent recovery copy: {e}"))?;
    std::io::copy(&mut input, &mut output).map_err(|e| format!("Cannot copy recoverable save version: {e}"))?;
    output.sync_all().map_err(|e| format!("Cannot persist recovery copy: {e}"))?;
    if hash_regular(source)? != before || hash_regular(&temp)? != before {
        return Err("Recoverable save version changed while copying; both files retained".into());
    }
    fs::hard_link(&temp, destination).map_err(|e| format!("Cannot publish recovery copy exclusively: {e}"))?;
    fs::remove_file(&temp).map_err(|e| format!("Recovery copy published but temporary link remains: {e}"))?;
    Ok(())
}

fn collect_staged(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.file_type().is_dir() && !meta.file_type().is_symlink() && name != DIR {
            collect_staged(&entry.path(), out)?;
        } else if meta.file_type().is_file() && name.starts_with(".lyra_save_")
            && (name.ends_with(".tmp") || name.ends_with(".bak")) {
            out.push(entry.path());
        }
    }
    Ok(())
}

fn expose_save_conflict(base: &Path, conflict: &Path, nonce: &str) -> Result<(), String> {
    let journal = fs::read(conflict).ok().and_then(|raw| parse_save_journal(&raw).ok());
    if let Some(journal) = &journal {
        let target = crate::gdrive::sync::resolve_safe_path(base, &journal.name)?;
        let parent = target.parent().ok_or("Invalid save parent")?;
        let dir = metadata_dir(base)?;
        for (label, source) in [
            ("editor", parent.join(&journal.temp)),
            ("backup", parent.join(&journal.backup)),
            ("old", dir.join(&journal.old_anchor)),
            ("new", dir.join(&journal.new_anchor)),
        ] {
            if !source.exists() { continue; }
            open_regular(&source)?;
            copy_rescue(&source, &base.join(format!("Lyra recovered save {nonce} {label}.md")))?;
        }
    } else {
        let mut staged = Vec::new();
        collect_staged(base, &mut staged)?;
        for (index, source) in staged.iter().enumerate() {
            copy_rescue(source, &base.join(format!("Lyra recovered save {nonce} orphan {index}.md")))?;
        }
    }
    Ok(())
}

fn quarantine_save_conflict(base: &Path) -> Result<(), String> {
    let journal_path = journal_path(base)?;
    if !journal_path.exists() { return Ok(()); }
    let nonce = format!("{:032x}", rand::random::<u128>());
    let conflict = metadata_dir(base)?.join(format!("save-conflict-{nonce}.json"));
    fs::rename(&journal_path, &conflict).map_err(|e| format!("Cannot isolate conflicting save journal: {e}"))?;
    expose_save_conflict(base, &conflict, &nonce)
}

pub(crate) fn recover_save(base: &Path) -> Result<(), String> {
    match recover_save_inner(base) {
        Ok(()) => Ok(()),
        Err(error) => {
            if let Err(quarantine_error) = quarantine_save_conflict(base) {
                return Err(format!("{error}; save journal retained or isolated, rescue copy pending: {quarantine_error}"));
            }
            Err(format!("{error}; recoverable versions were retained and the conflict was isolated"))
        }
    }
}

pub(crate) fn pending_save_conflicts(base: &Path) -> Result<Vec<String>, String> {
    let mut conflicts = Vec::new();
    for entry in fs::read_dir(metadata_dir(base)?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("save-conflict-") && name.ends_with(".json") {
            let nonce = name.trim_start_matches("save-conflict-").trim_end_matches(".json");
            let _ = expose_save_conflict(base, &entry.path(), nonce);
            conflicts.push(name);
        }
    }
    conflicts.sort();
    Ok(conflicts)
}

pub(crate) fn save_conflict_for_note(base: &Path, name: &str) -> Result<bool, String> {
    for entry in fs::read_dir(metadata_dir(base)?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.starts_with("save-conflict-") || !file_name.ends_with(".json") { continue; }
        if fs::read(entry.path()).ok().and_then(|raw| parse_save_journal(&raw).ok())
            .is_some_and(|journal| journal.name == name) { return Ok(true); }
    }
    Ok(false)
}

#[cfg(test)]
pub(crate) fn save_note(base: &Path, name: &str, expected_id: &str, content: &[u8]) -> Result<i64, String> {
    let expected_hash = hash_regular(&base.join(name))?;
    save_note_versioned(base, name, expected_id, &expected_hash, content)
}

pub(crate) fn save_note_versioned(base: &Path, name: &str, expected_id: &str, expected_hash: &str, content: &[u8]) -> Result<i64, String> {
    recover_save(base)?;
    if save_conflict_for_note(base, name)? {
        return Err("This note has a pending save conflict; its versions must be recovered before saving".into());
    }
    let target = verify_note(base, name, expected_id)?;
    if hash_regular(&target)? != expected_hash {
        return Err("Note content changed externally; save refused and draft retained".into());
    }
    let dir = metadata_dir(base)?;
    let nonce = format!("{:032x}", rand::random::<u128>());
    let temp_name = format!(".lyra_save_{nonce}.tmp");
    let backup_name = format!(".lyra_save_{nonce}.bak");
    let new_anchor_name = format!("{expected_id}.{nonce}.new");
    let temp = target.parent().ok_or("Invalid save parent")?.join(&temp_name);
    let new_anchor = dir.join(&new_anchor_name);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)
        .map_err(|e| format!("Cannot stage guarded save: {e}"))?;
    file.write_all(content).and_then(|_| file.sync_all()).map_err(|e| format!("Cannot persist guarded save: {e}"))?;
    fs::hard_link(&temp, &new_anchor).map_err(|e| format!("Cannot preserve pending save on this volume: {e}"))?;
    let old_anchor_name = read_registry(base)?.notes.get(name).ok_or("Missing note identity")?.anchor.clone();
    let old_anchor = dir.join(&old_anchor_name);
    let old_physical = physical_id(&open_regular(&old_anchor)?)?;
    let new_physical = physical_id(&open_regular(&new_anchor)?)?;
    let journal = SaveJournal { version: 1, name: name.into(), id: expected_id.into(), temp: temp_name, backup: backup_name, new_anchor: new_anchor_name, old_anchor: old_anchor_name, old_physical, new_physical, expected_old_hash: Some(expected_hash.to_string()) };
    write_journal(base, &journal)?;
    recover_save(base)?;
    let modified = fs::metadata(&target).ok().and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64).unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    Ok(modified)
}

pub(crate) fn open_note(base: &Path, name: &str) -> Result<(String, String), String> {
    let path = crate::gdrive::sync::resolve_safe_path(base, name)?;
    let mut registry = read_registry(base)?;
    if let Some(note) = registry.notes.get(name) {
        let anchor = metadata_dir(base)?.join(&note.anchor);
        let mut file = open_regular(&path)?;
        if physical_id(&file)? != physical_id(&open_regular(&anchor)?)? {
            return Err("Note identity changed externally; pending edits must be recovered manually".into());
        }
        let mut content = String::new();
        file.read_to_string(&mut content).map_err(|e| format!("Cannot read note: {e}"))?;
        if !same_physical(&path, &anchor)? { return Err("Note path changed while opening; retry after resolving the external change".into()); }
        return Ok((note.id.clone(), content));
    }
    let mut file = open_regular(&path)?;
    let id = physical_id(&file)?;
    let dir = metadata_dir(base)?;
    for note in registry.notes.values() {
        let anchor = dir.join(&note.anchor);
        if physical_id(&open_regular(&anchor)?)? == id {
            return Err("This file already has a Lyra identity at another path; resolve the external move first".into());
        }
    }
    let logical_id = format!("{:032x}", rand::random::<u128>());
    let anchor_name = format!("{logical_id}.anchor");
    let anchor = dir.join(&anchor_name);
    fs::hard_link(&path, &anchor).map_err(|e| format!("Cannot establish stable note identity on this volume: {e}"))?;
    if physical_id(&file)? != physical_id(&open_regular(&anchor)?)? || !same_physical(&path, &anchor)? {
        return Err("Note changed while its identity was being registered".into());
    }
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| format!("Cannot read note: {e}"))?;
    if !same_physical(&path, &anchor)? { return Err("Note path changed while opening; retry".into()); }
    registry.notes.insert(name.to_string(), NoteIdentity { id: logical_id.clone(), anchor: anchor_name });
    write_registry(base, &registry)?;
    Ok((logical_id, content))
}

pub(crate) fn registration_status(base: &Path, name: &str) -> Result<(bool, bool), String> {
    let registry = read_registry(base)?;
    Ok((!registry.notes.contains_key(name), registry.retired.contains_key(name)))
}

pub(crate) fn read_unverified(base: &Path, name: &str) -> Result<String, String> {
    let path = crate::gdrive::sync::resolve_safe_path(base, name)?;
    let mut file = open_regular(&path)?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| format!("Cannot read note: {e}"))?;
    Ok(content)
}

pub(crate) fn verify_note(base: &Path, name: &str, expected_id: &str) -> Result<PathBuf, String> {
    let path = crate::gdrive::sync::resolve_safe_path(base, name)?;
    let registry = read_registry(base)?;
    let note = registry.notes.get(name).ok_or("Note has no registered identity; reopen it before saving")?;
    if note.id != expected_id { return Err("Note identity changed; save refused and draft retained".into()); }
    if !same_physical(&path, &metadata_dir(base)?.join(&note.anchor))? {
        return Err("Note was moved or replaced externally; save refused and draft retained".into());
    }
    Ok(path)
}

pub(crate) fn verify_registered_path(base: &Path, name: &str) -> Result<(), String> {
    let registry = read_registry(base)?;
    let note = registry.notes.get(name).ok_or("Moved note has no registered identity")?;
    verify_note(base, name, &note.id).map(|_| ())
}

pub(crate) fn remap_notes(base: &Path, changes: &[(String, String)]) -> Result<(), String> {
    let mut registry = read_registry(base)?;
    for (old, new) in changes {
        if let Some(note) = registry.notes.get(old).cloned() {
            if registry.notes.get(new).is_some_and(|other| other.id != note.id) {
                return Err(format!("Identity collision at {new}"));
            }
            if !same_physical(&base.join(new), &metadata_dir(base)?.join(&note.anchor))? {
                return Err(format!("Moved note identity cannot be verified at {new}"));
            }
            registry.notes.remove(old);
            registry.retired.insert(old.clone(), note.id.clone());
            registry.notes.insert(new.clone(), note);
        }
    }
    write_registry(base, &registry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("one.md"), "original").unwrap();
        dir
    }

    #[test]
    fn logical_identity_survives_guarded_atomic_saves() {
        let dir = fixture();
        let base = dir.path();
        let (id, content) = open_note(base, "one.md").unwrap();
        assert_eq!(content, "original");
        save_note(base, "one.md", &id, b"first").unwrap();
        save_note(base, "one.md", &id, b"second").unwrap();
        assert_eq!(open_note(base, "one.md").unwrap(), (id, "second".into()));
        assert!(!journal_path(base).unwrap().exists());
    }

    #[test]
    fn versioned_save_rejects_external_in_place_change_and_keeps_both_versions() {
        let dir = fixture();
        let base = dir.path();
        let (id, original) = open_note(base, "one.md").unwrap();
        let expected = content_sha256(original.as_bytes());
        let before = physical_id_at_path(&base.join("one.md")).unwrap();
        fs::write(base.join("one.md"), b"external").unwrap();
        assert_eq!(physical_id_at_path(&base.join("one.md")).unwrap(), before);
        assert!(save_note_versioned(base, "one.md", &id, &expected, b"editor").is_err());
        assert_eq!(fs::read(base.join("one.md")).unwrap(), b"external");
        assert_eq!(open_note(base, "one.md").unwrap().1, "external");
        assert!(save_note_versioned(base, "one.md", &id, &content_sha256(b"external"), b"editor").is_ok());
        assert_eq!(fs::read(base.join("one.md")).unwrap(), b"editor");
    }

    #[test]
    fn versioned_save_restores_external_write_at_last_exchange_window() {
        let dir = fixture();
        let base = dir.path();
        let (id, original) = open_note(base, "one.md").unwrap();
        SAVE_BEFORE_EXCHANGE.with(|hook| *hook.borrow_mut() = Some(|path| {
            fs::write(path, b"external").unwrap();
        }));
        let result = save_note_versioned(base, "one.md", &id, &content_sha256(original.as_bytes()), b"editor");
        assert!(result.is_err());
        assert_eq!(fs::read(base.join("one.md")).unwrap(), b"external");
        assert!(read_journal(base).unwrap().is_none());
        assert_eq!(pending_save_conflicts(base).unwrap().len(), 1);
        let rescue = fs::read_dir(base).unwrap().filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().contains("recovered save")
                && fs::read(entry.path()).ok().as_deref() == Some(b"editor"))
            .expect("editor content must remain visible for recovery");
        assert_eq!(fs::read(rescue.path()).unwrap(), b"editor");
        let conflict = pending_save_conflicts(base).unwrap().remove(0);
        let journal: SaveJournal = serde_json::from_slice(&fs::read(metadata_dir(base).unwrap().join(conflict)).unwrap()).unwrap();
        fs::write(base.join(journal.temp), b"later external edit").unwrap();
        assert_eq!(fs::read(rescue.path()).unwrap(), b"editor", "rescue must not share a mutable inode with staging");
        fs::write(base.join("two.md"), b"second").unwrap();
        let (second_id, second) = open_note(base, "two.md").unwrap();
        save_note_versioned(base, "two.md", &second_id, &content_sha256(second.as_bytes()), b"saved").unwrap();
        assert_eq!(fs::read(base.join("two.md")).unwrap(), b"saved");
    }

    #[test]
    fn failed_rescue_copy_isolates_conflict_and_retries_without_blocking_other_notes() {
        let dir = fixture();
        let base = dir.path();
        let (id, original) = open_note(base, "one.md").unwrap();
        SAVE_BEFORE_EXCHANGE.with(|hook| *hook.borrow_mut() = Some(|path| fs::write(path, b"external").unwrap()));
        SAVE_RESCUE_FAILURE.with(|failure| failure.set(true));
        let result = save_note_versioned(base, "one.md", &id, &content_sha256(original.as_bytes()), b"pending editor");
        assert!(result.is_err());
        assert!(read_journal(base).unwrap().is_none());
        assert!(save_conflict_for_note(base, "one.md").unwrap());
        assert_eq!(fs::read(base.join("one.md")).unwrap(), b"external");
        let conflict_name = fs::read_dir(metadata_dir(base).unwrap()).unwrap().filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name.starts_with("save-conflict-")).unwrap();
        let journal: SaveJournal = serde_json::from_slice(&fs::read(metadata_dir(base).unwrap().join(&conflict_name)).unwrap()).unwrap();
        assert_eq!(fs::read(base.join(&journal.temp)).unwrap(), b"pending editor");
        assert!(save_note_versioned(base, "one.md", &id, &content_sha256(b"external"), b"overwrite").is_err());
        fs::write(base.join("two.md"), b"second").unwrap();
        let (other_id, other_content) = open_note(base, "two.md").unwrap();
        save_note_versioned(base, "two.md", &other_id, &content_sha256(other_content.as_bytes()), b"saved").unwrap();
        assert_eq!(fs::read(base.join("two.md")).unwrap(), b"saved");
        assert_eq!(fs::read(base.join(&journal.temp)).unwrap(), b"pending editor");
        SAVE_RESCUE_FAILURE.with(|failure| failure.set(false));
        assert_eq!(pending_save_conflicts(base).unwrap(), [conflict_name]);
        assert!(fs::read_dir(base).unwrap().filter_map(Result::ok).any(|entry|
            entry.file_name().to_string_lossy().contains("recovered save")
                && fs::read(entry.path()).ok().as_deref() == Some(b"pending editor")));
        assert!(save_conflict_for_note(base, "one.md").unwrap());
    }

    #[test]
    fn reused_path_and_external_rename_refuse_pending_save() {
        let dir = fixture();
        let base = dir.path();
        let (id, _) = open_note(base, "one.md").unwrap();
        fs::rename(base.join("one.md"), base.join("moved.md")).unwrap();
        fs::write(base.join("one.md"), "replacement").unwrap();
        assert!(save_note(base, "one.md", &id, b"pending").is_err());
        assert_eq!(fs::read_to_string(base.join("one.md")).unwrap(), "replacement");
        assert_eq!(fs::read_to_string(base.join("moved.md")).unwrap(), "original");
        assert!(open_note(base, "one.md").is_err());
    }

    #[test]
    fn metadata_identity_rejects_replacement_even_with_identical_bytes() {
        let dir = fixture();
        let base = dir.path();
        let (id, _) = open_note(base, "one.md").unwrap();
        assert_eq!(verified_note_id(base, "one.md").unwrap(), Some(id));
        fs::rename(base.join("one.md"), base.join("old.md")).unwrap();
        fs::write(base.join("one.md"), "original").unwrap();
        assert_eq!(verified_note_id(base, "one.md").unwrap(), None);
    }

    #[test]
    fn malformed_save_journal_preserves_staged_bytes_and_does_not_block_other_notes() {
        let dir = fixture();
        let base = dir.path();
        fs::write(base.join(".lyra_save_incomplete.tmp"), b"pending editor text").unwrap();
        fs::write(journal_path(base).unwrap(), b"{broken").unwrap();
        assert!(recover_save(base).is_err());
        assert_eq!(pending_save_conflicts(base).unwrap().len(), 1);
        assert!(read_journal(base).unwrap().is_none());
        assert_eq!(fs::read(base.join(".lyra_save_incomplete.tmp")).unwrap(), b"pending editor text");
        assert!(fs::read_dir(base).unwrap().filter_map(Result::ok).any(|entry|
            entry.file_name().to_string_lossy().contains("recovered save")
                && fs::read(entry.path()).ok().as_deref() == Some(b"pending editor text")));
        assert!(recover_save(base).is_ok());
        let (id, text) = open_note(base, "one.md").unwrap();
        save_note_versioned(base, "one.md", &id, &content_sha256(text.as_bytes()), b"new content").unwrap();
    }

    #[test]
    fn scenario_b_external_content_and_persisted_editor_draft_survive_restart() {
        let dir = fixture();
        let base = dir.path();
        let (id, opened) = open_note(base, "one.md").unwrap();
        let draft_id = "abcdef1234567890";
        crate::drafts::save_draft_file(base, draft_id, r#"{"content":"editor B"}"#).unwrap();
        fs::write(base.join("one.md"), b"external C").unwrap();
        assert!(save_note_versioned(base, "one.md", &id, &content_sha256(opened.as_bytes()), b"editor B").is_err());
        assert_eq!(fs::read(base.join("one.md")).unwrap(), b"external C");
        assert!(crate::drafts::read_draft_file(base, draft_id).unwrap().unwrap().contains("editor B"));
        assert_eq!(open_note(base, "one.md").unwrap().1, "external C");
        assert!(crate::drafts::read_draft_file(base, draft_id).unwrap().unwrap().contains("editor B"));
    }

    #[test]
    fn legacy_save_journal_without_physical_hash_is_quarantined_with_visible_editor_copy() {
        let dir = fixture();
        let base = dir.path();
        let (id, _) = open_note(base, "one.md").unwrap();
        let old_anchor_name = read_registry(base).unwrap().notes["one.md"].anchor.clone();
        let old_anchor = metadata_dir(base).unwrap().join(&old_anchor_name);
        let temp_name = ".lyra_save_legacy.tmp";
        let temp = base.join(temp_name);
        fs::write(&temp, b"legacy pending editor").unwrap();
        let new_anchor_name = format!("{id}.legacy.new");
        let new_anchor = metadata_dir(base).unwrap().join(&new_anchor_name);
        fs::hard_link(&temp, &new_anchor).unwrap();
        write_journal(base, &SaveJournal {
            version: 1, name: "one.md".into(), id,
            temp: temp_name.into(), backup: ".lyra_save_legacy.bak".into(),
            new_anchor: new_anchor_name, old_anchor: old_anchor_name,
            old_physical: physical_id_at_path(&old_anchor).unwrap(),
            new_physical: physical_id_at_path(&new_anchor).unwrap(),
            expected_old_hash: None,
        }).unwrap();
        assert!(recover_save(base).is_err());
        assert_eq!(fs::read(base.join("one.md")).unwrap(), b"original");
        assert_eq!(pending_save_conflicts(base).unwrap().len(), 1);
        assert!(fs::read_dir(base).unwrap().filter_map(Result::ok).any(|entry|
            entry.file_name().to_string_lossy().contains("recovered save")
                && fs::read(entry.path()).ok().as_deref() == Some(b"legacy pending editor")));
    }

    #[test]
    fn scenario_c_external_move_during_pending_save_preserves_both_versions_and_identity() {
        let dir = fixture();
        let base = dir.path();
        let (id, original) = open_note(base, "one.md").unwrap();
        SAVE_BEFORE_EXCHANGE.with(|hook| *hook.borrow_mut() = Some(|path| {
            fs::rename(path, path.with_file_name("moved.md")).unwrap();
        }));
        assert!(save_note_versioned(base, "one.md", &id, &content_sha256(original.as_bytes()), b"pending editor").is_err());
        assert!(!base.join("one.md").exists());
        assert_eq!(fs::read(base.join("moved.md")).unwrap(), b"original");
        assert!(fs::read_dir(base).unwrap().filter_map(Result::ok).any(|entry|
            entry.file_name().to_string_lossy().contains("recovered save")
                && fs::read(entry.path()).ok().as_deref() == Some(b"pending editor")));
        remap_notes(base, &[("one.md".into(), "moved.md".into())]).unwrap();
        assert_eq!(verified_note_id(base, "moved.md").unwrap(), Some(id));
    }

    #[test]
    fn prepared_save_recovers_after_restart_without_overwriting_external_replacement() {
        let dir = fixture();
        let base = dir.path();
        let (id, _) = open_note(base, "one.md").unwrap();
        let identity_dir = metadata_dir(base).unwrap();
        let temp_name = ".lyra_save_fixture.tmp";
        let new_anchor_name = format!("{id}.fixture.new");
        let old_anchor_name = format!("{id}.anchor");
        fs::write(base.join(temp_name), "pending").unwrap();
        fs::hard_link(base.join(temp_name), identity_dir.join(&new_anchor_name)).unwrap();
        let journal = SaveJournal { version: 1, name: "one.md".into(), id: id.clone(), temp: temp_name.into(),
            backup: ".lyra_save_fixture.bak".into(), new_anchor: new_anchor_name.clone(), old_anchor: old_anchor_name.clone(),
            old_physical: physical_id(&open_regular(&identity_dir.join(old_anchor_name)).unwrap()).unwrap(),
            new_physical: physical_id(&open_regular(&identity_dir.join(new_anchor_name)).unwrap()).unwrap(),
            expected_old_hash: Some(content_sha256(b"original")) };
        write_journal(base, &journal).unwrap();
        recover_save(base).unwrap();
        recover_save(base).unwrap();
        assert_eq!(fs::read_to_string(base.join("one.md")).unwrap(), "pending");
        assert!(!journal_path(base).unwrap().exists());
    }

    #[test]
    fn corrupt_registry_uses_backup_and_unknown_identity_stops() {
        let dir = fixture();
        let base = dir.path();
        let (id, _) = open_note(base, "one.md").unwrap();
        let registry = read_registry(base).unwrap();
        write_registry(base, &registry).unwrap();
        fs::write(metadata_dir(base).unwrap().join(REGISTRY), b"{").unwrap();
        assert_eq!(open_note(base, "one.md").unwrap().0, id);
        fs::write(metadata_dir(base).unwrap().join("registry.json.bak"), b"{").unwrap();
        assert!(open_note(base, "one.md").is_err());
    }
}
