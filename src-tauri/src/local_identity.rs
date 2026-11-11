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
fn physical_id(file: &File) -> Result<String, String> {
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

pub(crate) fn same_physical(a: &Path, b: &Path) -> Result<bool, String> {
    let first = open_regular(a)?;
    let second = open_regular(b)?;
    Ok(physical_id(&first)? == physical_id(&second)?)
}

fn journal_path(base: &Path) -> Result<PathBuf, String> { Ok(metadata_dir(base)?.join("save-journal.json")) }

fn read_journal(base: &Path) -> Result<Option<SaveJournal>, String> {
    match fs::read(journal_path(base)?) {
        Ok(raw) => {
            let journal: SaveJournal = serde_json::from_slice(&raw).map_err(|e| format!("Invalid local save journal: {e}"))?;
            if journal.version != 1 || journal.id.is_empty() || journal.temp.contains('/') || journal.backup.contains('/') || journal.new_anchor.contains('/') || journal.old_anchor.contains('/') {
                return Err("Invalid local save journal fields".into());
            }
            Ok(Some(journal))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read local save journal: {error}")),
    }
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

pub(crate) fn recover_save(base: &Path) -> Result<(), String> {
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

pub(crate) fn save_note(base: &Path, name: &str, expected_id: &str, content: &[u8]) -> Result<i64, String> {
    recover_save(base)?;
    let target = verify_note(base, name, expected_id)?;
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
    let journal = SaveJournal { version: 1, name: name.into(), id: expected_id.into(), temp: temp_name, backup: backup_name, new_anchor: new_anchor_name, old_anchor: old_anchor_name, old_physical, new_physical };
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
            new_physical: physical_id(&open_regular(&identity_dir.join(new_anchor_name)).unwrap()).unwrap() };
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
