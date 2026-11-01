//! Migration tests.
//!
//! Every test builds its own temporary `Documents` + config pair, so the real
//! `~/Documents/lyra` is never touched.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::workspaces::{origins, registry};
use crate::gdrive::archive;

struct Home {
    base: PathBuf,
    docs: PathBuf,
    config: PathBuf,
}

impl Home {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("lyra-ws-migration-{:032x}", rand::random::<u128>()));
        let docs = base.join("Documents");
        let config = base.join("config");
        fs::create_dir_all(docs.join("lyra")).unwrap();
        fs::create_dir_all(&config).unwrap();
        Self { base, docs, config }
    }

    fn ctx(&self) -> Ctx {
        Ctx::new(self.docs.clone(), self.config.clone())
    }

    fn root(&self) -> PathBuf {
        self.docs.join("lyra")
    }

    fn workspace(&self, id: &str) -> PathBuf {
        self.root().join("workspaces").join(id)
    }

    fn write(&self, name: &str, content: &str) {
        fs::write(self.root().join(name), content).unwrap();
    }

    fn read(&self, path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn status(ctx: &Ctx, journal: &Journal, name: &str) -> ItemStatus {
    statuses(ctx, journal)
        .unwrap()
        .into_iter()
        .find(|view| view.name == name)
        .unwrap_or_else(|| panic!("'{name}' is not part of the journal"))
        .status
}

fn item<'a>(journal: &'a Journal, name: &str) -> &'a Item {
    journal
        .items
        .iter()
        .find(|item| item.name == name)
        .unwrap_or_else(|| panic!("'{name}' is not part of the journal"))
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if entry.file_name().to_str() == Some(name) {
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

#[test]
fn migrates_every_note_and_preserves_the_originals() {
    let home = Home::new();
    home.write("Nota.md", "hola");
    home.write("Otra.txt", "mundo");
    let ctx = home.ctx();

    let journal = run(&ctx, &Faults::none()).unwrap().expect("notes to migrate");

    assert_eq!(journal.phase, Phase::Retired);
    assert!(journal.done());
    assert_eq!(journal.workspace_id, "ws_001");
    assert_eq!(journal.workspace_name, "Mi espacio");
    assert_eq!(journal.items.len(), 2);

    let workspace = home.workspace("ws_001");
    assert_eq!(home.read(&workspace.join("Nota.md")), "hola");
    assert_eq!(home.read(&workspace.join("Otra.txt")), "mundo");
    assert!(paths::marker_path(&workspace).is_file());

    // Root is empty: nothing is edited in the legacy folder any more.
    assert!(paths::note_files(&home.root()).unwrap().is_empty());

    let report = journal.retire.clone().unwrap();
    assert!(report.conflicts.is_empty());
    assert_eq!(report.retired.len(), 2);
    let rescatados = home.docs.join(&report.directory);
    assert_eq!(home.read(&rescatados.join("Nota.md")), "hola");
    assert_eq!(home.read(&rescatados.join("Otra.txt")), "mundo");

    let loaded = registry::load(&home.docs, &home.config).unwrap();
    assert!(!loaded.is_rebuilt());
    let saved = loaded.into_registry().unwrap();
    assert_eq!(saved.active_workspace_id, "ws_001");
    assert_eq!(saved.migration_id.as_deref(), Some(journal.migration_id.as_str()));
    assert_eq!(saved.workspaces[0].name, "Mi espacio");
}

#[test]
fn empty_root_still_creates_the_workspace() {
    let home = Home::new();
    let ctx = home.ctx();

    let journal = run(&ctx, &Faults::none()).unwrap().expect("workspace is created");

    assert!(journal.done());
    assert!(journal.items.is_empty());
    assert!(paths::marker_path(&home.workspace("ws_001")).is_file());
    assert!(registry::load(&home.docs, &home.config)
        .unwrap()
        .registry()
        .is_some());
}

#[test]
fn run_is_idempotent_and_a_finished_migration_is_not_restarted() {
    let home = Home::new();
    home.write("Nota.md", "hola");
    let ctx = home.ctx();

    let first = run(&ctx, &Faults::none()).unwrap().unwrap();
    let second = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert_eq!(first.migration_id, second.migration_id);
    assert!(second.done());
    assert_eq!(
        paths::note_files(&home.workspace("ws_001")).unwrap(),
        vec!["Nota.md".to_string()]
    );

    // Once the journal is gone (or the app was upgraded from a workspace-only
    // install) the migration must not run again.
    fs::remove_file(ctx.journal_path()).unwrap();
    fs::remove_file(ctx.journal_path().with_file_name(".lyra_migration.json.bak")).unwrap();
    assert!(run(&ctx, &Faults::none()).unwrap().is_none());
    assert!(paths::marker_path(&home.workspace("ws_001")).is_file());
}

#[test]
fn orphan_workspace_directories_are_never_reused() {
    let home = Home::new();
    fs::create_dir_all(home.workspace("ws_003")).unwrap();
    home.write("Nota.md", "hola");
    let ctx = home.ctx();

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert_eq!(journal.workspace_id, "ws_004");
    assert!(!paths::marker_path(&home.workspace("ws_003")).is_file());
    assert!(paths::marker_path(&home.workspace("ws_004")).is_file());
}

// ---------------------------------------------------------------------------
// Never overwrite
// ---------------------------------------------------------------------------

#[test]
fn a_different_destination_is_never_overwritten_and_keep_both_preserves_both() {
    let home = Home::new();
    home.write("Nota.md", "hola");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    let workspace = home.workspace("ws_001");
    fs::write(workspace.join("Nota.md"), "otra version").unwrap();

    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    assert_eq!(status(&ctx, &journal, "Nota.md"), ItemStatus::DestinationConflict);
    assert_eq!(home.read(&workspace.join("Nota.md")), "otra version");

    let blocked = gate(&ctx, &journal).unwrap();
    assert!(!blocked.open);
    assert_eq!(blocked.blocks.len(), 1);
    assert_eq!(blocked.blocks[0].name, "Nota.md");

    let journal = resolve_item(&ctx, "Nota.md", Action::KeepBoth, &Faults::none()).unwrap();
    assert_eq!(status(&ctx, &journal, "Nota.md"), ItemStatus::Copied);
    assert_eq!(home.read(&workspace.join("Nota.md")), "otra version");
    assert_eq!(item(&journal, "Nota.md").dest(), "Nota (2).md");
    assert_eq!(home.read(&workspace.join("Nota (2).md")), "hola");
    assert!(gate(&ctx, &journal).unwrap().open);

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert!(journal.retire.unwrap().conflicts.is_empty());
    // The pre-existing copy is untouched and the original is preserved.
    assert_eq!(home.read(&workspace.join("Nota.md")), "otra version");
    assert_eq!(home.read(&workspace.join("Nota (2).md")), "hola");
    assert!(paths::note_files(&home.root()).unwrap().is_empty());
    let rescatados = find_file(&home.root().join("rescatados"), "Nota.md").expect("original kept");
    assert_eq!(home.read(&rescatados), "hola");
}

#[test]
fn adopt_destination_keeps_the_existing_copy_and_retires_the_original() {
    let home = Home::new();
    home.write("Nota.md", "hola");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    let workspace = home.workspace("ws_001");
    fs::write(workspace.join("Nota.md"), "version del espacio").unwrap();

    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    let journal = resolve_item(&ctx, "Nota.md", Action::AdoptDestination, &Faults::none()).unwrap();
    assert_eq!(status(&ctx, &journal, "Nota.md"), ItemStatus::Copied);
    assert_eq!(home.read(&workspace.join("Nota.md")), "version del espacio");
    assert!(gate(&ctx, &journal).unwrap().open);

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert!(journal.retire.unwrap().conflicts.is_empty());
    assert_eq!(home.read(&workspace.join("Nota.md")), "version del espacio");
    // No data loss: the discarded original is stored, not deleted.
    let rescatados = find_file(&home.root().join("rescatados"), "Nota.md").expect("original kept");
    assert_eq!(home.read(&rescatados), "hola");
}

#[test]
fn archived_and_active_notes_keep_their_local_state_without_transferring_remote_permissions() {
    let home = Home::new();
    home.write("Archived.md", "archived content");
    home.write("Active.txt", "active content");
    archive::set_archived(&home.root(), "Archived.md", true, None).unwrap();
    archive::set_archived(&home.root(), "Active.txt", false, None).unwrap();
    let original_ledger = fs::read(home.root().join(".lyra_archive_state.json")).unwrap();

    let journal = run(&home.ctx(), &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    let projection = archive::projection(&home.workspace("ws_001"), None).unwrap();
    assert_eq!(projection.archived_names, vec!["Archived.md"]);
    assert_eq!(home.read(&home.workspace("ws_001").join("Active.txt")), "active content");
    assert_eq!(fs::read(home.root().join(".lyra_archive_state.json")).unwrap(), original_ledger);
}

#[test]
fn legacy_preferences_can_seed_archiving_when_no_causal_ledger_exists() {
    let home = Home::new();
    home.write("Archived.md", "content");
    fs::write(home.root().join(".preferences.json"), r#"{"paper":["Archived.md"]}"#).unwrap();
    let original_preferences = fs::read(home.root().join(".preferences.json")).unwrap();

    let journal = run(&home.ctx(), &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert!(!journal.archive_ledger_present);
    assert!(!home.workspace("ws_001").join(".lyra_archive_state.json").exists());
    archive::initialize_legacy(&home.workspace("ws_001"), &["Archived.md".into()]).unwrap();
    let projection = archive::projection(&home.workspace("ws_001"), None).unwrap();
    assert_eq!(projection.archived_names, vec!["Archived.md"]);
    assert_eq!(fs::read(home.root().join(".preferences.json")).unwrap(), original_preferences);
}

#[test]
fn adopting_a_different_destination_does_not_inherit_the_original_archive_state() {
    let home = Home::new();
    home.write("Same.md", "original");
    archive::set_archived(&home.root(), "Same.md", true, None).unwrap();
    let ctx = home.ctx();
    prepare(&ctx, &Faults::none()).unwrap();
    fs::write(home.workspace("ws_001").join("Same.md"), "different destination").unwrap();
    resolve_item(&ctx, "Same.md", Action::AdoptDestination, &Faults::none()).unwrap();
    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert!(archive::projection(&home.workspace("ws_001"), None).unwrap().archived_names.is_empty());
    assert_eq!(home.read(&home.workspace("ws_001").join("Same.md")), "different destination");
    assert!(find_file(&home.root().join("rescatados"), "Same.md").is_some());
}

#[test]
fn keep_both_maps_archived_state_to_the_copied_original() {
    let home = Home::new();
    home.write("Same.md", "original");
    archive::set_archived(&home.root(), "Same.md", true, None).unwrap();
    let ctx = home.ctx();
    prepare(&ctx, &Faults::none()).unwrap();
    fs::write(home.workspace("ws_001").join("Same.md"), "different destination").unwrap();
    resolve_item(&ctx, "Same.md", Action::KeepBoth, &Faults::none()).unwrap();
    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    let projection = archive::projection(&home.workspace("ws_001"), None).unwrap();
    assert_eq!(projection.archived_names, vec!["Same (2).md"]);
    assert_eq!(home.read(&home.workspace("ws_001").join("Same.md")), "different destination");
    assert_eq!(home.read(&home.workspace("ws_001").join("Same (2).md")), "original");
}

// ---------------------------------------------------------------------------
// Deferred notes and new root notes
// ---------------------------------------------------------------------------

#[test]
fn a_deferred_note_stays_intact_in_the_root_and_is_never_counted_as_migrated() {
    let home = Home::new();
    home.write("A.md", "a");
    home.write("B.md", "b");
    let ctx = home.ctx();

    prepare(&ctx, &Faults::none()).unwrap();
    let journal = resolve_item(&ctx, "A.md", Action::Defer, &Faults::none()).unwrap();
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::Deferred);

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());

    // Deferred note: untouched, not copied, still reported.
    assert_eq!(home.read(&home.root().join("A.md")), "a");
    assert!(!home.workspace("ws_001").join("A.md").exists());
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::Deferred);
    let report = journal.retire.clone().unwrap();
    assert_eq!(report.retired.len(), 1);
    assert_eq!(report.retired[0].name, "B.md");

    let stray_views = strays(&ctx, &journal).unwrap();
    let deferred = stray_views
        .iter()
        .find(|view| view.name == "A.md")
        .expect("deferred note still listed");
    assert!(deferred.deferred);
    assert!(!stray_views.iter().any(|view| view.name == "B.md"));

    // Importing it later moves the original to rescatados, never deletes it.
    let mut journal = journal;
    import_stray(&ctx, &mut journal, "A.md").unwrap();
    assert!(!home.root().join("A.md").exists());
    assert_eq!(home.read(&home.workspace("ws_001").join("A.md")), "a");
    assert!(journal.items.iter().all(|item| item.name != "A.md"));
    let imported = find_file(&home.root().join("rescatados"), "A.md").expect("import kept");
    assert_eq!(home.read(&imported), "a");
}

#[test]
fn a_note_that_appears_in_the_root_blocks_the_gate_until_it_is_imported() {
    let home = Home::new();
    home.write("A.md", "a");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    assert!(gate(&ctx, &journal).unwrap().open);

    home.write("Nueva.md", "nueva");
    let blocked = gate(&ctx, &journal).unwrap();
    assert!(!blocked.open);
    assert!(blocked.blocks.is_empty());
    assert_eq!(blocked.strays, vec!["Nueva.md".to_string()]);

    // Nothing is activated while an unknown note sits in the root.
    let mut journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert_eq!(journal.phase, Phase::Copied);
    assert!(!journal.done());

    // An existing copy is never overwritten by an import.
    let workspace = home.workspace("ws_001");
    fs::write(workspace.join("Nueva.md"), "preexistente").unwrap();
    let error = import_stray(&ctx, &mut journal, "Nueva.md").unwrap_err();
    assert!(error.contains("ya tiene una nota"));
    assert_eq!(home.read(&workspace.join("Nueva.md")), "preexistente");
    assert_eq!(home.read(&home.root().join("Nueva.md")), "nueva");
    fs::remove_file(workspace.join("Nueva.md")).unwrap();

    import_stray(&ctx, &mut journal, "Nueva.md").unwrap();
    assert!(gate(&ctx, &journal).unwrap().open);
    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert_eq!(home.read(&workspace.join("Nueva.md")), "nueva");
    assert!(!home.root().join("Nueva.md").exists());
}

#[test]
fn a_new_root_note_can_be_deferred_and_keeps_being_reported() {
    let home = Home::new();
    home.write("A.md", "a");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    home.write("Nueva.md", "nueva");
    assert!(!gate(&ctx, &journal).unwrap().open);

    defer_stray(&ctx, &mut journal, "Nueva.md").unwrap();
    assert!(gate(&ctx, &journal).unwrap().open);
    assert!(strays(&ctx, &journal)
        .unwrap()
        .iter()
        .any(|view| view.name == "Nueva.md" && view.deferred));

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert_eq!(home.read(&home.root().join("Nueva.md")), "nueva");
    assert!(!home.workspace("ws_001").join("Nueva.md").exists());
    // The warning never disappears while the note stays in the root.
    assert!(strays(&ctx, &journal)
        .unwrap()
        .iter()
        .any(|view| view.name == "Nueva.md" && view.deferred));
}

#[cfg(unix)]
#[test]
fn symlinked_notes_are_never_followed_or_imported() {
    let home = Home::new();
    let outside = home.base.join("fuera.md");
    fs::write(&outside, "secreto").unwrap();
    home.write("Real.md", "real");
    std::os::unix::fs::symlink(&outside, home.root().join("Enlace.md")).unwrap();
    let ctx = home.ctx();

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    let workspace = home.workspace("ws_001");
    assert!(!workspace.join("Enlace.md").exists());
    assert_eq!(home.read(&outside), "secreto");
    assert!(fs::symlink_metadata(home.root().join("Enlace.md"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(journal.retire.clone().unwrap().retired.len(), 1);
    assert!(strays(&ctx, &journal)
        .unwrap()
        .iter()
        .any(|view| view.name == "Enlace.md" && view.deferred && !view.importable));

    // It is also not importable by hand.
    let mut journal = journal;
    assert!(import_stray(&ctx, &mut journal, "Enlace.md").is_err());
    assert!(home.root().join("Enlace.md").exists());
}

// ---------------------------------------------------------------------------
// Changed / missing sources
// ---------------------------------------------------------------------------

#[test]
fn a_changed_source_is_detected_and_keep_both_migrates_the_current_content() {
    let home = Home::new();
    home.write("A.md", "v1");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    home.write("A.md", "version dos");
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::SourceChanged);

    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::SourceChanged);
    assert!(!gate(&ctx, &journal).unwrap().open);

    // Nothing was copied behind the user's back.
    assert!(!home.workspace("ws_001").join("A.md").exists());

    let journal = resolve_item(&ctx, "A.md", Action::KeepBoth, &Faults::none()).unwrap();
    assert_eq!(item(&journal, "A.md").sha256, origins::hash_bytes(b"version dos"));
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::Copied);
    assert_eq!(
        home.read(&home.workspace("ws_001").join(item(&journal, "A.md").dest())),
        "version dos"
    );

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert!(journal.retire.unwrap().conflicts.is_empty());
    let rescatados = find_file(&home.root().join("rescatados"), "A.md").expect("original kept");
    assert_eq!(home.read(&rescatados), "version dos");
}

#[test]
fn a_missing_source_can_only_be_dismissed_explicitly() {
    let home = Home::new();
    home.write("A.md", "a");
    home.write("B.md", "b");
    let ctx = home.ctx();

    let journal = prepare(&ctx, &Faults::none()).unwrap();
    fs::remove_file(home.root().join("A.md")).unwrap();
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::SourceMissing);
    assert!(!gate(&ctx, &journal).unwrap().open);

    // Deferring something that no longer exists is not allowed.
    assert!(resolve_item(&ctx, "A.md", Action::Defer, &Faults::none()).is_err());

    let mut journal = resolve_item(&ctx, "A.md", Action::Dismiss, &Faults::none()).unwrap();
    assert_eq!(journal.items.len(), 1);
    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    assert_eq!(status(&ctx, &journal, "B.md"), ItemStatus::Copied);
    assert!(gate(&ctx, &journal).unwrap().open);
}

#[test]
fn an_interrupted_copy_resumes_without_duplicating() {
    let home = Home::new();
    home.write("A.md", "a");
    home.write("B.md", "b");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    let faults = Faults {
        fail_copy: Some("A.md".to_string()),
        fail_retire: None,
    };
    copy_all(&ctx, &mut journal, &faults).unwrap();

    let workspace = home.workspace("ws_001");
    assert!(!workspace.join("A.md").exists());
    assert!(workspace.join("B.md").exists());
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::PendingCopy);
    assert!(item(&journal, "A.md").note.is_some());
    assert!(!gate(&ctx, &journal).unwrap().open);

    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert_eq!(home.read(&workspace.join("A.md")), "a");
    assert_eq!(
        paths::note_files(&workspace).unwrap(),
        vec!["A.md".to_string(), "B.md".to_string()]
    );
}

// ---------------------------------------------------------------------------
// Safe retire
// ---------------------------------------------------------------------------

#[test]
fn a_retire_conflict_keeps_the_file_and_still_completes() {
    let home = Home::new();
    home.write("A.md", "a");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    activate(&ctx, &mut journal).unwrap();
    assert_eq!(journal.phase, Phase::Activated);

    // The user kept editing the original after the copy was verified.
    home.write("A.md", "editada despues");
    retire_all(&ctx, &mut journal, &Faults::none()).unwrap();

    assert_eq!(journal.phase, Phase::Retired);
    assert!(journal.done(), "a conflict must not block startup forever");
    let report = journal.retire.clone().unwrap();
    assert!(report.retired.is_empty());
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].reason, "source_changed");
    assert_eq!(home.read(&home.root().join("A.md")), "editada despues");
    assert_eq!(home.read(&home.workspace("ws_001").join("A.md")), "a");

    let restarted = crate::workspaces::snapshot(&home.docs, &home.config, &Faults::none()).unwrap();
    assert!(restarted.done);
    assert!(restarted.retire_conflicts.iter().any(|conflict| conflict.name == "A.md"));
    assert_eq!(home.read(&home.root().join("A.md")), "editada despues");

    // Resolution keeps it as a pending import, still visible.
    resolve_retire(&ctx, &mut journal, "A.md", RetireAction::KeepAsPending).unwrap();
    assert!(journal.retire.clone().unwrap().conflicts.is_empty());
    assert_eq!(status(&ctx, &journal, "A.md"), ItemStatus::Deferred);
    assert_eq!(home.read(&home.root().join("A.md")), "editada despues");
    assert!(strays(&ctx, &journal)
        .unwrap()
        .iter()
        .any(|view| view.name == "A.md" && view.deferred));

    // The journal is still on disk and consistent.
    let reloaded = load(&ctx).unwrap().unwrap();
    assert!(reloaded.done());
}

#[test]
fn retiring_an_original_never_overwrites_an_existing_backup_name() {
    let home = Home::new();
    home.write("A.md", "original");
    let backups = home.root().join("rescatados").join("fixture");
    fs::create_dir_all(&backups).unwrap();
    fs::write(backups.join("A.md"), "existing backup").unwrap();
    let moved = move_no_clobber(&home.root().join("A.md"), &backups, "A.md").unwrap();
    assert_eq!(moved.file_name().unwrap(), "A (2).md");
    assert_eq!(home.read(&backups.join("A.md")), "existing backup");
    assert_eq!(home.read(&moved), "original");
    assert!(!home.root().join("A.md").exists());
}

#[test]
fn a_missing_destination_copy_keeps_the_original() {
    let home = Home::new();
    home.write("A.md", "a");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    activate(&ctx, &mut journal).unwrap();
    fs::remove_file(home.workspace("ws_001").join("A.md")).unwrap();

    retire_all(&ctx, &mut journal, &Faults::none()).unwrap();
    assert!(journal.done());
    let report = journal.retire.clone().unwrap();
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].reason, "destination_missing");
    assert_eq!(home.read(&home.root().join("A.md")), "a");

    resolve_retire(&ctx, &mut journal, "A.md", RetireAction::MoveToRescatados).unwrap();
    assert!(!home.root().join("A.md").exists());
    let moved = find_file(&home.root().join("rescatados"), "A.md").expect("moved to rescatados");
    assert_eq!(home.read(&moved), "a");
}

#[test]
fn a_failed_move_is_reported_and_never_deletes_the_original() {
    let home = Home::new();
    home.write("A.md", "a");
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    activate(&ctx, &mut journal).unwrap();

    let faults = Faults {
        fail_copy: None,
        fail_retire: Some("A.md".to_string()),
    };
    retire_all(&ctx, &mut journal, &faults).unwrap();
    assert!(journal.done());
    let report = journal.retire.clone().unwrap();
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].reason, "retire_failed");
    assert_eq!(home.read(&home.root().join("A.md")), "a");
    assert_eq!(home.read(&home.workspace("ws_001").join("A.md")), "a");

    // Retrying the retire of a single conflict is not offered: resolving it
    // moves the original, which is the non-destructive outcome.
    resolve_retire(&ctx, &mut journal, "A.md", RetireAction::MoveToRescatados).unwrap();
    assert!(!home.root().join("A.md").exists());
    assert_eq!(home.read(&home.workspace("ws_001").join("A.md")), "a");
    assert!(find_file(&home.root().join("rescatados"), "A.md").is_some());
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

#[test]
fn a_corrupt_journal_is_rebuilt_from_the_origins_ledger() {
    let home = Home::new();
    home.write("A.md", "a");
    home.write("B.md", "b");
    archive::set_archived(&home.root(), "A.md", true, None).unwrap();
    let ctx = home.ctx();

    let mut journal = prepare(&ctx, &Faults::none()).unwrap();
    copy_all(&ctx, &mut journal, &Faults::none()).unwrap();
    let backup = ctx.journal_path().with_file_name(".lyra_migration.json.bak");
    fs::write(ctx.journal_path(), b"{roto").unwrap();
    fs::write(&backup, b"{roto").unwrap();

    let recovered = load(&ctx).unwrap().expect("rebuilt from the origins ledger");
    assert_eq!(recovered.workspace_id, "ws_001");
    assert_eq!(recovered.workspace_name, "Mi espacio");
    assert_eq!(recovered.items.len(), 2);
    assert_eq!(recovered.archived_names, vec!["A.md"]);
    assert!(recovered.items.iter().all(|item| item.decision == Decision::Pending));
    assert!(recovered.error.is_some());
    assert_eq!(recovered.items[0].sha256, origins::hash_bytes(b"a"));

    // The copies already on disk are recognised by content, not duplicated.
    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());
    assert_eq!(
        paths::note_files(&home.workspace("ws_001")).unwrap(),
        vec!["A.md".to_string(), "B.md".to_string()]
    );
    assert!(paths::note_files(&home.root()).unwrap().is_empty());
}

#[test]
fn the_origins_ledger_always_describes_the_current_content() {
    let home = Home::new();
    home.write("A.md", "v1");
    let ctx = home.ctx();

    let journal = prepare(&ctx, &Faults::none()).unwrap();
    let ledger = origins::load_ledger(&home.docs).unwrap().unwrap();
    assert_eq!(ledger.workspace_id, "ws_001");
    assert_eq!(ledger.migration_id, journal.migration_id);
    assert_eq!(ledger.get("A.md").unwrap().sha256, origins::hash_bytes(b"v1"));

    home.write("A.md", "version dos");
    resolve_item(&ctx, "A.md", Action::Retry, &Faults::none()).unwrap();
    let ledger = origins::load_ledger(&home.docs).unwrap().unwrap();
    assert_eq!(ledger.get("A.md").unwrap().sha256, origins::hash_bytes(b"version dos"));
}

// ---------------------------------------------------------------------------
// Post-migration imports
// ---------------------------------------------------------------------------

#[test]
fn notes_appearing_after_the_migration_can_still_be_imported() {
    let home = Home::new();
    home.write("A.md", "a");
    let ctx = home.ctx();
    let journal = run(&ctx, &Faults::none()).unwrap().unwrap();
    assert!(journal.done());

    // Simulate a note dropped into the legacy folder by another program.
    fs::remove_file(ctx.journal_path()).unwrap();
    fs::remove_file(ctx.journal_path().with_file_name(".lyra_migration.json.bak")).unwrap();
    home.write("Externa.md", "externa");

    let mut journal = journal_for_imports(&ctx).unwrap().expect("registry exists");
    assert!(journal.done());
    assert_eq!(journal.workspace_id, "ws_001");

    import_stray(&ctx, &mut journal, "Externa.md").unwrap();
    assert!(!home.root().join("Externa.md").exists());
    assert_eq!(
        home.read(&home.workspace("ws_001").join("Externa.md")),
        "externa"
    );
    assert!(find_file(&home.root().join("rescatados"), "Externa.md").is_some());
    // Re-running the migration is still a no-op.
    assert!(run(&ctx, &Faults::none()).unwrap().is_some());
    assert!(registry::load(&home.docs, &home.config)
        .unwrap()
        .registry()
        .is_some());
}

#[test]
fn journal_for_imports_without_any_install_returns_nothing() {
    let home = Home::new();
    let ctx = home.ctx();
    assert!(journal_for_imports(&ctx).unwrap().is_none());
}
