//! Origin stamps and content hashing.
//!
//! A stamp records `size`, `mtime` and (when the filesystem exposes it)
//! `birthtime`. It lets the migration decide whether a file changed without
//! re-reading every note on each status poll. `birthtime` is only consulted
//! when size and mtime still match, which is exactly the case a "copy with
//! preserved timestamps" replacement would produce.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::paths;

pub const LEDGER_SCHEMA: u32 = 2;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    pub size: u64,
    pub mtime_ms: u128,
    #[serde(default)]
    pub birthtime_ms: u128,
}

pub fn timestamp_ms(value: Option<std::time::SystemTime>) -> u128 {
    value
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub fn stamp_of(metadata: &fs::Metadata) -> Stamp {
    Stamp {
        size: metadata.len(),
        mtime_ms: timestamp_ms(metadata.modified().ok()),
        birthtime_ms: timestamp_ms(metadata.created().ok()),
    }
}

/// True when the file on disk still matches `stamp`.
pub fn unchanged(stamp: &Stamp, metadata: &fs::Metadata) -> bool {
    let current = stamp_of(metadata);
    if current.size != stamp.size || current.mtime_ms != stamp.mtime_ms {
        return false;
    }
    // Only meaningful when both sides expose a birth time; otherwise the
    // size/mtime match is the best evidence available.
    stamp.birthtime_ms == 0 || current.birthtime_ms == 0 || stamp.birthtime_ms == current.birthtime_ms
}

pub fn modified(path: &Path) -> Result<Stamp, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect '{}': {e}", path.display()))?;
    Ok(stamp_of(&metadata))
}

/// SHA-256 of the file plus the number of bytes read.
pub fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Cannot read '{}': {e}", path.display()))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

#[cfg(test)]
pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Durable record of what the root notes looked like before the migration.
/// It is written *before* anything is copied and is used both to detect
/// post-copy edits and to rebuild the journal if it is ever damaged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginEntry {
    pub name: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub dest_name: Option<String>,
    pub stamp: Stamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OriginsLedger {
    pub schema_version: u32,
    pub migration_id: String,
    /// Workspace the migration was heading to. Required to rebuild the
    /// journal, so a ledger without it is refused instead of guessed.
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub entries: Vec<OriginEntry>,
}

#[cfg(test)]
impl OriginsLedger {
    pub fn new(migration_id: String, workspace_id: String) -> Self {
        Self {
            schema_version: LEDGER_SCHEMA,
            migration_id,
            workspace_id,
            entries: Vec::new(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&OriginEntry> {
        self.entries.iter().find(|entry| entry.name == name)
    }

    pub fn upsert(&mut self, entry: OriginEntry) {
        match self.entries.iter_mut().find(|existing| existing.name == entry.name) {
            Some(existing) => *existing = entry,
            None => self.entries.push(entry),
        }
        self.entries.sort_by(|a, b| a.name.cmp(&b.name));
    }
}

pub fn load_ledger(documents: &Path) -> Result<Option<OriginsLedger>, String> {
    let path = paths::origins_path(documents);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read origins ledger: {error}")),
    };
    let ledger: OriginsLedger = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Origins ledger is unreadable: {e}"))?;
    if ledger.schema_version != LEDGER_SCHEMA {
        return Err(format!(
            "Unsupported origins ledger version {}",
            ledger.schema_version
        ));
    }
    Ok(Some(ledger))
}

pub fn save_ledger(documents: &Path, ledger: &OriginsLedger) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(ledger).map_err(|e| e.to_string())?;
    paths::write_atomic(&paths::origins_path(documents), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("lyra-ws-origins-{:032x}", rand::random::<u128>()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ledger_with(path: &Path, name: &str, bytes: &[u8]) -> OriginsLedger {
        let metadata = fs::metadata(path.join(name)).unwrap();
        let mut ledger = OriginsLedger::new("m1".into(), "ws_001".into());
        ledger.upsert(OriginEntry {
            name: name.to_string(),
            sha256: hash_bytes(bytes),
            size: bytes.len() as u64,
            dest_name: None,
            stamp: stamp_of(&metadata),
        });
        ledger
    }

    #[test]
    fn hashes_match_known_content() {
        // SHA-256 of "abc".
        assert_eq!(
            hash_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let dir = TestDir::new();
        fs::write(dir.0.join("n.md"), b"abc").unwrap();
        assert_eq!(hash_file(&dir.0.join("n.md")).unwrap(), (hash_bytes(b"abc"), 3));
    }

    #[test]
    fn hash_file_reports_missing_files() {
        let dir = TestDir::new();
        assert!(hash_file(&dir.0.join("nada.md")).is_err());
    }

    #[test]
    fn unchanged_detects_touch_and_resize() {
        let dir = TestDir::new();
        fs::write(dir.0.join("n.md"), b"contenido").unwrap();
        let ledger = ledger_with(&dir.0, "n.md", b"contenido");
        let entry = ledger.get("n.md").unwrap();
        let metadata = fs::metadata(dir.0.join("n.md")).unwrap();
        assert!(unchanged(&entry.stamp, &metadata));

        fs::write(dir.0.join("n.md"), b"contenido ampliado").unwrap();
        let metadata = fs::metadata(dir.0.join("n.md")).unwrap();
        assert!(!unchanged(&entry.stamp, &metadata));
    }

    #[test]
    fn birthtime_is_only_consulted_when_size_and_mtime_match() {
        let dir = TestDir::new();
        fs::write(dir.0.join("n.md"), b"contenido").unwrap();
        let metadata = fs::metadata(dir.0.join("n.md")).unwrap();
        let stamp = stamp_of(&metadata);

        // A different size or mtime is always a change.
        let mut resized = stamp;
        resized.size = stamp.size.saturating_add(1);
        assert!(!unchanged(&resized, &metadata));
        let mut touched = stamp;
        touched.mtime_ms = stamp.mtime_ms.saturating_add(1);
        assert!(!unchanged(&touched, &metadata));

        // With size and mtime intact, a different birth time means the file
        // was replaced by a copy that preserved timestamps.
        let mut replaced = stamp;
        replaced.birthtime_ms = stamp.birthtime_ms.saturating_add(1_000);
        if stamp.birthtime_ms == 0 {
            // Filesystem without birth time: size+mtime is the only evidence.
            assert!(unchanged(&replaced, &metadata));
        } else {
            assert!(!unchanged(&replaced, &metadata));
        }
    }

    #[test]
    fn ledger_round_trips_and_is_sorted() {
        let dir = TestDir::new();
        fs::write(dir.0.join("b.md"), b"b").unwrap();
        fs::write(dir.0.join("a.md"), b"a").unwrap();
        let mut ledger = ledger_with(&dir.0, "b.md", b"b");
        let a = ledger_with(&dir.0, "a.md", b"a").entries.remove(0);
        ledger.upsert(a);
        save_ledger(&dir.0, &ledger).unwrap();
        let loaded = load_ledger(&dir.0).unwrap().unwrap();
        assert_eq!(
            loaded.entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            vec!["a.md", "b.md"]
        );
        assert_eq!(loaded.entries[1].sha256, hash_bytes(b"b"));
    }

    #[test]
    fn missing_ledger_is_none_and_corrupt_ledger_is_an_error() {
        let dir = TestDir::new();
        assert!(load_ledger(&dir.0).unwrap().is_none());
        fs::create_dir_all(dir.0.join("lyra")).unwrap();
        fs::write(paths::origins_path(&dir.0), b"{roto").unwrap();
        assert!(load_ledger(&dir.0).is_err());
    }
}
