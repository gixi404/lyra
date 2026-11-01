//! Filesystem layout for workspaces and the migration.
//!
//! Every path in this module is derived from `~/Documents` plus a validated
//! workspace id, so nothing outside the Documents folder can be addressed.
//! This module has no Tauri dependency: it is unit-tested against temporary
//! directories.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::ids;
use super::types::WorkspaceMarker;

/// Folder that has always held the notes. Kept as the anchor of the layout:
/// `~/Documents/lyra/`.
pub const ROOT_FOLDER: &str = "lyra";
/// Workspaces live inside the Lyra folder: `~/Documents/lyra/workspaces/`.
pub const WORKSPACES_FOLDER: &str = "workspaces";
/// Originals preserved after a migration.
pub const RESCATADOS_FOLDER: &str = "rescatados";
pub const MARKER_FILE: &str = ".lyra_workspace.json";
pub const JOURNAL_FILE: &str = ".lyra_migration.json";
pub const ORIGINS_FILE: &str = ".lyra_fs_origins.json";
pub const RETIRED_MANIFEST: &str = ".lyra_retired.json";

pub fn lyra_root(documents: &Path) -> PathBuf {
    documents.join(ROOT_FOLDER)
}

pub fn workspaces_root(documents: &Path) -> PathBuf {
    lyra_root(documents).join(WORKSPACES_FOLDER)
}

/// Resolves the directory of a workspace after validating its id.
pub fn workspace_dir(documents: &Path, id: &str) -> Result<PathBuf, String> {
    ids::validate_id(id)?;
    Ok(workspaces_root(documents).join(id))
}

pub fn marker_path(dir: &Path) -> PathBuf {
    dir.join(MARKER_FILE)
}

pub fn journal_path(documents: &Path) -> PathBuf {
    lyra_root(documents).join(JOURNAL_FILE)
}

pub fn origins_path(documents: &Path) -> PathBuf {
    lyra_root(documents).join(ORIGINS_FILE)
}

pub fn rescatados_root(documents: &Path) -> PathBuf {
    lyra_root(documents).join(RESCATADOS_FOLDER)
}

/// `rescatados/<prefix>-<stamp>/`, where the stamp makes every batch unique.
pub fn rescatados_dir(documents: &Path, prefix: &str, stamp: i64) -> PathBuf {
    rescatados_root(documents).join(format!("{prefix}-{stamp}"))
}

pub fn is_note_name(name: &str) -> bool {
    !name.starts_with('.') && (name.ends_with(".md") || name.ends_with(".txt"))
}

/// A directory entry that *looks* like a note, including symlinked ones so
/// the migration can refuse to follow them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteEntry {
    pub name: String,
    pub symlink: bool,
}

/// Lists note-like entries of `dir`. Directories and hidden files are skipped.
/// Symlinks are reported but never followed.
pub fn scan_notes(dir: &Path) -> Result<Vec<NoteEntry>, String> {
    let mut notes = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(notes),
        Err(error) => return Err(format!("Cannot list notes in '{}': {error}", dir.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot read note entry: {e}"))?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        if !is_note_name(&name) {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Cannot inspect '{name}': {e}"))?;
        if file_type.is_symlink() {
            notes.push(NoteEntry { name, symlink: true });
        } else if file_type.is_file() {
            notes.push(NoteEntry { name, symlink: false });
        }
    }
    notes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(notes)
}

/// Names of regular notes (symlinks excluded), which is what the app lists.
#[cfg(test)]
pub fn note_files(dir: &Path) -> Result<Vec<String>, String> {
    Ok(scan_notes(dir)?
        .into_iter()
        .filter(|entry| !entry.symlink)
        .map(|entry| entry.name)
        .collect())
}

pub fn read_marker(dir: &Path) -> Result<Option<WorkspaceMarker>, String> {
    let path = marker_path(dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read workspace marker: {error}")),
    };
    let marker: WorkspaceMarker = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Workspace marker is unreadable: {e}"))?;
    Ok(Some(marker))
}

pub fn write_marker(dir: &Path, marker: &WorkspaceMarker) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    write_atomic(&marker_path(dir), &bytes)
}

/// Durable write: temp file in the same directory, `sync_all`, then rename.
/// If the destination cannot be replaced atomically (Windows), it is removed
/// first; callers keep a `.bak` copy for the files that need it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Destination path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create '{}': {e}", parent.display()))?;
    let temporary = parent.join(format!(
        ".lyra_tmp_{:032x}",
        rand::random::<u128>()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("Cannot create temporary file: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("Cannot write temporary file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Cannot sync temporary file: {e}"))?;
        drop(file);
        if fs::rename(&temporary, path).is_ok() {
            return Ok(());
        }
        // Windows does not replace an existing file with `rename`.
        let _ = fs::remove_file(path);
        fs::rename(&temporary, path).map_err(|e| format!("Cannot replace '{}': {e}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::types::{WorkspaceKind, SCHEMA_VERSION};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("lyra-ws-paths-{:032x}", rand::random::<u128>()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn layout_is_anchored_on_documents() {
        let documents = Path::new("/home/user/Documents");
        assert_eq!(lyra_root(documents), documents.join("lyra"));
        assert_eq!(workspaces_root(documents), documents.join("lyra/workspaces"));
        assert_eq!(workspace_dir(documents, "ws_001").unwrap(), documents.join("lyra/workspaces/ws_001"));
    }

    #[test]
    fn workspace_dir_rejects_unsafe_ids() {
        let documents = Path::new("/home/user/Documents");
        for bad in ["", "../lyra", "ws_1", "ws_001/../../etc", "/etc", "ws_000"] {
            assert!(workspace_dir(documents, bad).is_err(), "id '{bad}' must be rejected");
        }
    }

    #[test]
    fn scan_notes_reports_symlinks_without_following_them() {
        let dir = TestDir::new();
        fs::write(dir.0.join("Nota.md"), "hola").unwrap();
        fs::write(dir.0.join("Otra.txt"), "hola").unwrap();
        fs::write(dir.0.join(".oculto.md"), "x").unwrap();
        fs::write(dir.0.join("imagen.png"), "x").unwrap();
        fs::create_dir(dir.0.join("carpeta.md")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.0.join("Nota.md"), dir.0.join("enlace.md")).unwrap();

        let scanned = scan_notes(&dir.0).unwrap();
        #[cfg(unix)]
        assert_eq!(
            scanned,
            vec![
                NoteEntry { name: "Nota.md".into(), symlink: false },
                NoteEntry { name: "Otra.txt".into(), symlink: false },
                NoteEntry { name: "enlace.md".into(), symlink: true },
            ]
        );
        #[cfg(not(unix))]
        assert_eq!(scanned.len(), 2);
        assert_eq!(note_files(&dir.0).unwrap(), vec!["Nota.md".to_string(), "Otra.txt".to_string()]);
    }

    #[test]
    fn scan_notes_of_missing_directory_is_empty() {
        let dir = TestDir::new();
        assert!(scan_notes(&dir.0.join("nada")).unwrap().is_empty());
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temporary_files() {
        let dir = TestDir::new();
        let path = dir.0.join("datos.json");
        write_atomic(&path, b"uno").unwrap();
        write_atomic(&path, b"dos").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "dos");
        let names: Vec<String> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["datos.json".to_string()]);
    }

    #[test]
    fn marker_round_trip_and_missing() {
        let dir = TestDir::new();
        assert!(read_marker(&dir.0).unwrap().is_none());
        let marker = WorkspaceMarker {
            schema_version: SCHEMA_VERSION,
            workspace_id: "ws_001".into(),
            name: "Mi espacio".into(),
            kind: WorkspaceKind::Local,
            created_at: 7,
            origin: "migration".into(),
        };
        write_marker(&dir.0, &marker).unwrap();
        let loaded = read_marker(&dir.0).unwrap().unwrap();
        assert_eq!(loaded.workspace_id, marker.workspace_id);
        assert_eq!(loaded.name, marker.name);
        assert_eq!(loaded.kind, marker.kind);
        fs::write(marker_path(&dir.0), b"{roto").unwrap();
        assert!(read_marker(&dir.0).is_err());
    }
}
