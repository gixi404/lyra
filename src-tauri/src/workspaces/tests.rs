//! Snapshot / runtime decision tests.
//!
//! These exercise the layer the frontend boots from: what counts as `required`,
//! what stays visible after the migration, and which directory note commands
//! are allowed to touch.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::workspaces::migration::{self, ItemStatus, Phase};
use crate::workspaces::types::{WorkspaceKind, WorkspaceMarker, SCHEMA_VERSION};

struct Home {
    base: PathBuf,
    docs: PathBuf,
    config: PathBuf,
}

impl Home {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("lyra-ws-runtime-{:032x}", rand::random::<u128>()));
        let docs = base.join("Documents");
        let config = base.join("config");
        fs::create_dir_all(docs.join("lyra")).unwrap();
        fs::create_dir_all(&config).unwrap();
        Self { base, docs, config }
    }

    fn root(&self) -> PathBuf {
        self.docs.join("lyra")
    }

    fn workspace(&self, id: &str) -> PathBuf {
        self.root().join("workspaces").join(id)
    }

    fn snapshot(&self) -> Snapshot {
        snapshot(&self.docs, &self.config, &Faults::none()).unwrap()
    }

    fn write(&self, name: &str, content: &str) {
        fs::write(self.root().join(name), content).unwrap();
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn an_empty_install_migrates_and_becomes_usable() {
    let home = Home::new();

    let snapshot = home.snapshot();

    assert!(!snapshot.required);
    assert!(snapshot.done);
    assert_eq!(snapshot.phase, Some(Phase::Retired));
    let workspace = snapshot.workspace.expect("workspace created");
    assert_eq!(workspace.id, "ws_001");
    assert_eq!(workspace.name, "Mi espacio");
    assert_eq!(workspace.directory, "lyra/workspaces/ws_001");
    assert_eq!(workspace.write_policy, WritePolicy::Editable);
    // Nothing to resolve and nothing to hash once the migration is over.
    assert!(snapshot.items.is_empty());
    assert!(snapshot.blocks.is_empty());
    assert!(snapshot.strays.is_empty());
    assert!(snapshot.retire_conflicts.is_empty());
    assert!(home.workspace("ws_001").is_dir());
}

#[test]
fn a_missing_active_workspace_does_not_open_the_gate_after_restart() {
    let home = Home::new();
    assert!(home.snapshot().done);
    fs::remove_dir_all(home.workspace("ws_001")).unwrap();

    let restarted = home.snapshot();
    assert!(restarted.required);
    assert!(!restarted.done);
    assert_eq!(restarted.workspace.unwrap().status, WorkspaceStatus::Missing);
    assert!(notes_dir(&home.docs, &home.config).is_err());
}

#[test]
fn stale_note_command_identity_is_rejected_after_workspace_switch() {
    let home = Home::new();
    home.snapshot();
    let ctx = Ctx::new(home.docs.clone(), home.config.clone());
    let second = management::create(&ctx, "Other").unwrap();
    ensure_active_workspace(&home.docs, &home.config, "ws_001").unwrap();
    management::select(&ctx, &second).unwrap();
    assert!(ensure_active_workspace(&home.docs, &home.config, "ws_001")
        .unwrap_err().contains("another workspace"));
    ensure_active_workspace(&home.docs, &home.config, &second).unwrap();
}

#[test]
fn process_lock_rejects_a_second_instance_before_migration_and_releases_on_exit() {
    if let Some(config) = std::env::var_os("LYRA_TEST_LOCK_CONFIG") {
        assert!(ProcessLock::acquire(Path::new(&config)).is_err());
        return;
    }
    let home = Home::new();
    let runtime = Runtime::new(home.docs.clone(), home.config.clone());
    let first = runtime.acquire_process_lock().unwrap();
    assert!(runtime.acquire_process_lock().is_err());
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("workspaces::tests::process_lock_rejects_a_second_instance_before_migration_and_releases_on_exit")
        .env("LYRA_TEST_LOCK_CONFIG", &home.config)
        .output()
        .unwrap();
    assert!(child.status.success(), "second process was not blocked: {}", String::from_utf8_lossy(&child.stderr));
    assert!(String::from_utf8_lossy(&child.stdout).contains("running 1 test"));
    assert!(!paths::journal_path(&home.docs).exists());
    drop(first);
    assert!(runtime.acquire_process_lock().is_ok());
}

#[test]
fn unresolved_system_directories_return_retryable_errors_without_creating_a_library() {
    let home = Home::new();
    let alternate = home.base.join("alternate");
    assert!(Runtime::from_resolved(Err("documents unavailable".into()), Ok(home.config.clone()))
        .unwrap_err().contains("Documentos"));
    assert!(Runtime::from_resolved(Ok(home.docs.clone()), Err("config unavailable".into()))
        .unwrap_err().contains("configuración"));
    assert!(!alternate.exists());
    assert!(Runtime::from_resolved(Ok(home.docs.clone()), Ok(home.config.clone())).is_ok());
    assert!(!paths::journal_path(&home.docs).exists());
}

#[test]
fn a_conflict_blocks_boot_and_is_reported_per_note() {
    let home = Home::new();
    home.write("Nota.md", "hola");
    let ctx = Ctx::new(home.docs.clone(), home.config.clone());
    // Prepare first so the workspace id is fixed, then plant other content.
    migration::prepare(&ctx, &Faults::none()).unwrap();
    fs::write(home.workspace("ws_001").join("Nota.md"), "otra version").unwrap();

    let snapshot = home.snapshot();

    assert!(snapshot.required);
    assert!(!snapshot.done);
    // The workspace is not committed to the registry while the gate is closed.
    assert!(snapshot.workspace.is_none());
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.items[0].name, "Nota.md");
    assert_eq!(snapshot.items[0].status, ItemStatus::DestinationConflict);
    assert_eq!(snapshot.blocks.len(), 1);
    assert_eq!(snapshot.blocks[0].name, "Nota.md");
    // The pre-existing copy is never overwritten.
    assert_eq!(
        fs::read_to_string(home.workspace("ws_001").join("Nota.md")).unwrap(),
        "otra version"
    );

    // Resolving with "keep both" opens the gate and finishes the migration.
    let resolved = snapshot_after(&Runtime::new(home.docs.clone(), home.config.clone()), |ctx| {
        migration::resolve_item(ctx, "Nota.md", migration::Action::KeepBoth, &Faults::none())
            .map(|_| ())
    })
    .unwrap();
    assert!(!resolved.required);
    assert!(resolved.done);
    assert_eq!(resolved.draft_conflict_names, vec!["Nota.md"]);
    assert!(resolved.blocks.is_empty());
    assert_eq!(resolved.retire_conflicts.len(), 0);
    assert_eq!(
        resolved.restore_dir.as_deref().map(|dir| dir.split('/').next()),
        Some(Some("lyra"))
    );
    assert_eq!(
        fs::read_to_string(home.workspace("ws_001").join("Nota (2).md")).unwrap(),
        "hola"
    );
}

#[test]
fn a_deferred_note_stays_reported_after_the_migration_ends() {
    let home = Home::new();
    home.write("A.md", "a");
    home.write("B.md", "b");
    let ctx = Ctx::new(home.docs.clone(), home.config.clone());
    migration::prepare(&ctx, &Faults::none()).unwrap();
    migration::resolve_item(&ctx, "A.md", migration::Action::Defer, &Faults::none()).unwrap();

    let snapshot = home.snapshot();
    assert!(snapshot.done);
    assert!(!snapshot.required);
    assert!(snapshot.blocks.is_empty());
    let deferred = snapshot
        .strays
        .iter()
        .find(|stray| stray.name == "A.md")
        .expect("deferred note is reported");
    assert!(deferred.deferred);
    assert_eq!(fs::read_to_string(home.root().join("A.md")).unwrap(), "a");
    assert!(!home.workspace("ws_001").join("A.md").exists());
}

#[test]
fn a_note_dropped_in_the_root_after_the_migration_is_visible_but_does_not_reopen_the_gate() {
    let home = Home::new();
    assert!(home.snapshot().done);

    home.write("Externa.md", "externa");
    let snapshot = home.snapshot();
    assert!(snapshot.done);
    assert!(!snapshot.required);
    assert!(snapshot.blocks.is_empty());
    assert_eq!(snapshot.strays.len(), 1);
    assert_eq!(snapshot.strays[0].name, "Externa.md");
    assert!(!snapshot.strays[0].deferred);

    // It can still be imported deliberately.
    let imported = snapshot_after(&Runtime::new(home.docs.clone(), home.config.clone()), |ctx| {
        let mut journal = migration::journal_for_imports(ctx)?.expect("workspace exists");
        migration::import_stray(ctx, &mut journal, "Externa.md")
    })
    .unwrap();
    assert!(imported.done);
    assert!(imported.strays.is_empty());
    assert_eq!(
        fs::read_to_string(home.workspace("ws_001").join("Externa.md")).unwrap(),
        "externa"
    );
    assert!(!home.root().join("Externa.md").exists());
}

#[test]
fn note_commands_only_use_a_committed_workspace() {
    let home = Home::new();
    assert!(editable_notes_dir(&home.docs, &home.config).is_err());
    assert!(notes_dir(&home.docs, &home.config).is_err());

    assert!(home.snapshot().done);
    assert_eq!(
        editable_notes_dir(&home.docs, &home.config).unwrap(),
        home.workspace("ws_001")
    );
    assert_eq!(notes_dir(&home.docs, &home.config).unwrap(), home.workspace("ws_001"));
}

#[test]
fn activated_workspace_remains_unavailable_until_originals_are_retired() {
    let other = Home::new();
    other.write("B.md", "b");
    let migration_ctx = Ctx::new(other.docs.clone(), other.config.clone());
    let mut journal = migration::prepare(&migration_ctx, &Faults::none()).unwrap();
    migration::copy_all(&migration_ctx, &mut journal, &Faults::none()).unwrap();
    migration::activate(&migration_ctx, &mut journal).unwrap();
    assert!(editable_notes_dir(&other.docs, &other.config).is_err());
    assert!(notes_dir(&other.docs, &other.config).is_err());
    migration::retire_all(&migration_ctx, &mut journal, &Faults::none()).unwrap();
    assert!(editable_notes_dir(&other.docs, &other.config).is_ok());
}

#[test]
fn a_workspace_whose_linkage_was_lost_is_never_editable() {
    let home = Home::new();
    let directory = home.workspace("ws_001");
    fs::create_dir_all(&directory).unwrap();
    paths::write_marker(
        &directory,
        &WorkspaceMarker {
            schema_version: SCHEMA_VERSION,
            workspace_id: "ws_001".to_string(),
            name: "Cuenta perdida".to_string(),
            kind: WorkspaceKind::GoogleDrive,
            created_at: 1,
            origin: "migration".to_string(),
        },
    )
    .unwrap();

    let snapshot = home.snapshot();
    let workspace = snapshot.workspace.expect("rebuilt from the marker");
    assert!(workspace.linkage_lost);
    assert_eq!(workspace.write_policy, WritePolicy::ReadOnly);
    // The app opens read-only instead of falling back to the legacy folder.
    assert!(snapshot.done);
    assert!(editable_notes_dir(&home.docs, &home.config).is_err());
}

#[test]
fn drive_sync_stays_paused_until_the_install_is_fully_migrated() {
    let home = Home::new();
    assert!(drive_sync_paused(&home.docs, &home.config));

    home.snapshot();
    // The journal is kept on purpose in F1, so Drive stays paused.
    assert!(paths::journal_path(&home.docs).exists());
    assert!(drive_sync_paused(&home.docs, &home.config));

    fs::remove_file(paths::journal_path(&home.docs)).unwrap();
    let _ = fs::remove_file(paths::journal_path(&home.docs).with_file_name(".lyra_migration.json.bak"));
    assert!(drive_sync_paused(&home.docs, &home.config));
}
