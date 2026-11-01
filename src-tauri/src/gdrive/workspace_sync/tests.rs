use super::*;
use crate::workspaces::sync_context::{Admission, SyncCoordinator};
use crate::workspaces::{management, migration::{Ctx, Faults}, snapshot, sync_context, types::WorkspaceKind};
use std::sync::Arc;

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("lyra-f4-manifest-{:032x}", rand::random::<u128>()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn identity() -> WorkspaceIdentity {
    WorkspaceIdentity {
        workspace_id: "ws_002".into(), account_sub: "verified-sub".into(),
        folder_nonce: "0123456789abcdef0123456789abcdef".into(),
    }
}

#[test]
fn identity_is_derived_from_the_active_bound_workspace_only() {
    let home = TestDir::new();
    let documents = home.0.join("Documents");
    let config = home.0.join("config");
    fs::create_dir_all(documents.join("lyra")).unwrap();
    fs::create_dir_all(&config).unwrap();
    snapshot(&documents, &config, &Faults::none()).unwrap();
    let ctx = Ctx::new(documents.clone(), config);
    let local = sync_context::current(&ctx.documents, &ctx.config).unwrap();
    assert!(resolve_identity(&ctx, &local).unwrap_err().contains("SyncDisabled"));
    let drive = management::create_with_kind(&ctx, "Drive", WorkspaceKind::GoogleDrive).unwrap();
    management::select(&ctx, &drive).unwrap();
    let disconnected = sync_context::current(&ctx.documents, &ctx.config).unwrap();
    assert!(resolve_identity(&ctx, &disconnected).unwrap_err().contains("no verified account"));
    management::bind_drive_account(&ctx, &drive, "verified-sub", "one@example.test").unwrap();
    let request = sync_context::current(&ctx.documents, &ctx.config).unwrap();
    let (resolved, dir) = resolve_identity(&ctx, &request).unwrap();
    assert_eq!(resolved.workspace_id, drive);
    assert_eq!(resolved.account_sub, "verified-sub");
    assert_eq!(dir, documents.join(format!("lyra/workspaces/{drive}")));
    assert!(resolve_identity(&ctx, &disconnected).unwrap_err().contains("SyncStale"));
}

fn owner<'a>(coordinator: &'a SyncCoordinator) -> (SyncRequest, SyncPermit<'a>) {
    let request = SyncRequest { workspace_id: "ws_002".into(), epoch: 7 };
    match coordinator.submit(request.clone(), &request).unwrap() {
        Admission::Active(permit) => (request, permit),
        Admission::Queued => panic!("expected owner"),
    }
}

fn mock_server<F>(handler: F) -> (String, std::thread::JoinHandle<()>)
where F: FnOnce(tiny_http::Server) + Send + 'static {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
    let handle = std::thread::spawn(move || handler(server));
    (base, handle)
}

#[tokio::test]
async fn remote_folder_created_before_manifest_commit_is_recovered_by_nonce() {
    let home = TestDir::new();
    let identity = identity();
    let nonce = identity.folder_nonce.clone();
    let (base, handle) = mock_server(move |server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        request.respond(tiny_http::Response::from_string(format!(
            r#"{{"id":"recovered-id","mimeType":"application/vnd.google-apps.folder","appProperties":{{"lyra_workspace_nonce":"{}"}}}}"#,
            nonce
        ))).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_string(format!(
            r#"{{"files":[{{"id":"recovered-id","mimeType":"application/vnd.google-apps.folder","appProperties":{{"lyra_workspace_nonce":"{}"}}}}]}}"#,
            nonce
        ))).unwrap();
    });
    let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
    // Simulate a successful remote create followed by a process interruption.
    client.create_workspace_folder("fake", &identity.workspace_id, &identity.folder_nonce).await.unwrap();
    assert!(!manifest_path(&home.0).exists());
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    let manifest = load(&home.0, &identity).unwrap();
    let recovered = resolve_folder(&home.0, &identity, manifest, &client, "fake", &permit,
        || Ok(request.clone())).await.unwrap();
    assert_eq!(recovered.folder_id.as_deref(), Some("recovered-id"));
    assert_eq!(load(&home.0, &identity).unwrap(), recovered);
    handle.join().unwrap();
}

#[tokio::test]
async fn remote_folder_network_error_cannot_create_or_commit() {
    let home = TestDir::new();
    let identity = identity();
    let (base, handle) = mock_server(|server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_string("bad request").with_status_code(400)).unwrap();
    });
    let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    let manifest = load(&home.0, &identity).unwrap();
    assert!(resolve_folder(&home.0, &identity, manifest, &client, "fake", &permit,
        || Ok(request.clone())).await.unwrap_err().contains("HTTP 400"));
    assert!(!manifest_path(&home.0).exists());
    handle.join().unwrap();
}

#[tokio::test]
async fn lost_folder_create_response_retries_the_same_drive_id() {
    let home = TestDir::new();
    let identity = identity();
    let (base, handle) = mock_server(|server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_string(r#"{"files":[]}"#)).unwrap();
        let request = server.recv().unwrap();
        assert!(request.url().contains("generateIds"));
        request.respond(tiny_http::Response::from_string(r#"{"ids":["planned-folder"]}"#)).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        drop(request);
    });
    let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    let manifest = load(&home.0, &identity).unwrap();
    assert!(resolve_folder(&home.0, &identity, manifest, &client, "fake", &permit,
        || Ok(request.clone())).await.is_err());
    handle.join().unwrap();
    assert!(load(&home.0, &identity).unwrap().folder_create_dispatched);
    assert_eq!(load(&home.0, &identity).unwrap().folder_create_id.as_deref(), Some("planned-folder"));
    let nonce = identity.folder_nonce.clone();
    let (base, handle) = mock_server(move |server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_string(r#"{"files":[]}"#)).unwrap();
        let mut request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        assert!(body.contains("\"id\":\"planned-folder\""));
        request.respond(tiny_http::Response::from_string("exists").with_status_code(409)).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        assert!(request.url().contains("planned-folder"));
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "id": "planned-folder", "mimeType": "application/vnd.google-apps.folder",
            "appProperties": {"lyra_workspace_nonce": nonce}, "trashed": false
        }).to_string())).unwrap();
    });
    let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    let manifest = load(&home.0, &identity).unwrap();
    let recovered = resolve_folder(&home.0, &identity, manifest, &client, "fake", &permit,
        || Ok(request.clone())).await.unwrap();
    assert_eq!(recovered.folder_id.as_deref(), Some("planned-folder"));
    handle.join().unwrap();
}

#[tokio::test]
async fn late_remote_listing_is_discarded_after_workspace_transition() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (base, handle) = mock_server(move |server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        let _ = entered_tx.send(());
        release_rx.recv().unwrap();
        request.respond(tiny_http::Response::from_string(
            r#"{"files":[{"id":"remote-note","name":"Note.md","mimeType":"text/markdown"}]}"#
        )).unwrap();
    });
    let coordinator = Arc::new(SyncCoordinator::default());
    let running = {
        let coordinator = Arc::clone(&coordinator);
        tokio::spawn(async move {
            let (request, permit) = owner(&coordinator);
            let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
            let mut manifest = WorkspaceManifest::new(&identity()).unwrap();
            manifest.folder_id = Some("bound-folder".into());
            fetch_remote_index(&manifest, &client, "fake", &permit, || Ok(request.clone())).await
        })
    };
    entered_rx.await.unwrap();
    let transition = coordinator.begin_transition();
    tokio::pin!(transition);
    tokio::select! {
        biased;
        _ = &mut transition => panic!("transition must wait for the in-flight HTTP effect"),
        _ = std::future::ready(()) => {},
    }
    release_tx.send(()).unwrap();
    assert!(running.await.unwrap().unwrap_err().contains("SyncStale"));
    drop(transition.await.unwrap());
    handle.join().unwrap();
}

fn bound_workspace() -> (TestDir, Ctx, SyncRequest, WorkspaceIdentity, PathBuf) {
    let home = TestDir::new();
    let documents = home.0.join("Documents");
    let config = home.0.join("config");
    fs::create_dir_all(documents.join("lyra")).unwrap();
    fs::create_dir_all(&config).unwrap();
    snapshot(&documents, &config, &Faults::none()).unwrap();
    let ctx = Ctx::new(documents, config);
    let drive = management::create_with_kind(&ctx, "Drive", WorkspaceKind::GoogleDrive).unwrap();
    management::select(&ctx, &drive).unwrap();
    management::bind_drive_account(&ctx, &drive, "verified-sub", "one@example.test").unwrap();
    let request = sync_context::current(&ctx.documents, &ctx.config).unwrap();
    let (identity, notes_dir) = resolve_identity(&ctx, &request).unwrap();
    (home, ctx, request, identity, notes_dir)
}

#[tokio::test]
async fn local_deletion_records_only_the_exact_note_identity() {
    let (_home, ctx, request, identity, notes_dir) = bound_workspace();
    fs::write(notes_dir.join("Note.md"), b"original").unwrap();
    super::super::provenance::record_local_write(&notes_dir, "Note.md", None, true).unwrap();
    let ledger = super::super::provenance::load_ledger(
        &super::super::provenance::get_ledger_path(&notes_dir)).unwrap().unwrap();
    let note_id = ledger.by_name["Note.md"].clone();
    let guard = MANIFEST_LOCK.lock().await;
    let mut manifest = load(&notes_dir, &identity).unwrap();
    manifest.folder_id = Some("bound-folder".into());
    manifest.files.insert("Note.md".into(), WorkspaceFile {
        drive_id: "remote-note".into(), digest: "digest".into(), note_id: note_id.clone(),
    });
    save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    delete_local_note(&ctx, &request, "Note.md", &guard).unwrap();
    let after = load(&notes_dir, &identity).unwrap();
    assert!(!notes_dir.join("Note.md").exists());
    assert_eq!(after.pending_deletions["Note.md"], WorkspaceTombstone {
        drive_id: "remote-note".into(), note_id,
    });
    let tombstone = &after.pending_deletions["Note.md"];
    assert!(tombstone_ready(&notes_dir, &identity, "Note.md", tombstone, "remote-note", &guard).unwrap());
    assert!(!tombstone_ready(&notes_dir, &identity, "Note.md", tombstone, "foreign-id", &guard).unwrap());
    fs::write(notes_dir.join("Note.md"), b"new note").unwrap();
    assert!(!tombstone_ready(&notes_dir, &identity, "Note.md", tombstone, "remote-note", &guard).unwrap());
}

#[tokio::test]
async fn replaced_note_never_inherits_a_remote_deletion() {
    let (_home, ctx, request, identity, notes_dir) = bound_workspace();
    fs::write(notes_dir.join("Note.md"), b"replacement").unwrap();
    super::super::provenance::record_local_write(&notes_dir, "Note.md", None, true).unwrap();
    let guard = MANIFEST_LOCK.lock().await;
    let mut manifest = load(&notes_dir, &identity).unwrap();
    manifest.files.insert("Note.md".into(), WorkspaceFile {
        drive_id: "old-remote".into(), digest: "old-digest".into(), note_id: "old-note".into(),
    });
    save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    delete_local_note(&ctx, &request, "Note.md", &guard).unwrap();
    let after = load(&notes_dir, &identity).unwrap();
    assert!(after.pending_deletions.is_empty());
    assert!(after.files.is_empty());
}

async fn pending_deletion() -> (TestDir, WorkspaceIdentity, PathBuf) {
    let (home, ctx, request, identity, notes_dir) = bound_workspace();
    fs::write(notes_dir.join("Note.md"), b"original").unwrap();
    provenance::record_local_write(&notes_dir, "Note.md", None, true).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("bound-folder".into());
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "remote-note".into(), digest: "digest".into(), note_id,
        });
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
        delete_local_note(&ctx, &request, "Note.md", &guard).unwrap();
    }
    (home, identity, notes_dir)
}

#[tokio::test]
async fn remote_deletion_preserves_tombstone_without_a_folder_precondition() {
    let (_home, identity, notes_dir) = pending_deletion().await;
    let (base, handle) = mock_server(|server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        assert!(request.url().contains("bound-folder"));
        request.respond(tiny_http::Response::from_string(
            r#"{"files":[{"id":"remote-note","name":"Note.md","mimeType":"text/markdown"}]}"#
        )).unwrap();
    });
    let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    assert!(flush_tombstone(&notes_dir, &identity, "Note.md", &client, "fake", &permit,
        || Ok(request.clone())).await.unwrap_err().contains("SyncPaused"));
    assert!(load(&notes_dir, &identity).unwrap().pending_deletions.contains_key("Note.md"));
    handle.join().unwrap();
}

#[tokio::test]
async fn remote_deletion_refuses_a_file_moved_outside_the_bound_folder() {
    let (_home, identity, notes_dir) = pending_deletion().await;
    let (base, handle) = mock_server(|server| {
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_string(r#"{"files":[]}"#)).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_string(
            r#"{"id":"remote-note","name":"Note.md","mimeType":"text/markdown","trashed":false}"#
        )).unwrap();
    });
    let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    assert!(flush_tombstone(&notes_dir, &identity, "Note.md", &client, "fake", &permit,
        || Ok(request.clone())).await.unwrap_err().contains("outside the bound folder"));
    assert!(load(&notes_dir, &identity).unwrap().pending_deletions.contains_key("Note.md"));
    handle.join().unwrap();
}

#[tokio::test]
async fn repeated_remote_deletion_checks_keep_tombstone_without_patch() {
    let (_home, identity, notes_dir) = pending_deletion().await;
    let (base, handle) = mock_server(|server| {
        for _ in 0..2 {
            let request = server.recv().unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Get);
            request.respond(tiny_http::Response::from_string(
                r#"{"files":[{"id":"remote-note","name":"Note.md","mimeType":"text/markdown"}]}"#
            )).unwrap();
        }
    });
    let client = super::super::client::DriveClient::new_with_base_url(base).unwrap();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    assert!(flush_tombstone(&notes_dir, &identity, "Note.md", &client, "fake", &permit,
        || Ok(request.clone())).await.is_err());
    assert!(load(&notes_dir, &identity).unwrap().pending_deletions.contains_key("Note.md"));
    assert!(flush_tombstone(&notes_dir, &identity, "Note.md", &client, "fake", &permit,
        || Ok(request.clone())).await.unwrap_err().contains("SyncPaused"));
    assert!(load(&notes_dir, &identity).unwrap().pending_deletions.contains_key("Note.md"));
    handle.join().unwrap();
}

#[tokio::test]
async fn cancellation_before_remote_deletion_sends_no_http_and_preserves_tombstone() {
    let (_home, identity, notes_dir) = pending_deletion().await;
    let client = super::super::client::DriveClient::new_with_base_url(
        "http://127.0.0.1:1".into()).unwrap();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    drop(coordinator.begin_transition().await.unwrap());
    assert!(flush_tombstone(&notes_dir, &identity, "Note.md", &client, "fake", &permit,
        || Ok(request.clone())).await.unwrap_err().contains("SyncStale"));
    assert!(load(&notes_dir, &identity).unwrap().pending_deletions.contains_key("Note.md"));
}

#[test]
fn empty_workspace_manifest_is_scoped_and_does_not_adopt_legacy_data() {
    let home = TestDir::new();
    fs::write(home.0.join(".gdrive_manifest_verified-sub.json"), b"{\"drive_folder_id\":\"legacy\"}").unwrap();
    let manifest = load(&home.0, &identity()).unwrap();
    assert_eq!(manifest.folder_id, None);
    assert!(manifest.files.is_empty());
    assert_eq!(manifest.workspace_id, "ws_002");
}

#[test]
fn folder_id_cannot_change_silently() {
    let mut manifest = WorkspaceManifest::new(&identity()).unwrap();
    manifest.confirm_folder("folder-a").unwrap();
    manifest.confirm_folder("folder-a").unwrap();
    assert!(manifest.confirm_folder("folder-b").unwrap_err().contains("manual repair"));
    assert_eq!(manifest.folder_id.as_deref(), Some("folder-a"));
}

#[tokio::test]
async fn stale_http_result_cannot_replace_newer_tombstone() {
    let home = TestDir::new();
    let identity = identity();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    let baseline = load(&home.0, &identity).unwrap();
    let mut newer = baseline.clone();
    newer.pending_deletions.insert("Note.md".into(), WorkspaceTombstone {
        drive_id: "remote-one".into(), note_id: "note-one".into(),
    });
    let saved = commit(&home.0, &identity, baseline.revision, newer, &permit, || Ok(request.clone())).await.unwrap();
    let mut stale = baseline;
    stale.folder_id = Some("folder-one".into());
    assert!(commit(&home.0, &identity, stale.revision, stale, &permit, || Ok(request.clone())).await
        .unwrap_err().contains("changed during synchronization"));
    assert_eq!(load(&home.0, &identity).unwrap(), saved);
}

#[tokio::test]
async fn cancelled_owner_cannot_commit_a_manifest() {
    let home = TestDir::new();
    let identity = identity();
    let coordinator = SyncCoordinator::default();
    let (request, permit) = owner(&coordinator);
    let transition = coordinator.begin_transition().await.unwrap();
    drop(transition);
    let next = WorkspaceManifest::new(&identity).unwrap();
    assert!(commit(&home.0, &identity, 0, next, &permit, || Ok(request.clone())).await
        .unwrap_err().contains("SyncStale"));
    assert!(!manifest_path(&home.0).exists());
}

#[test]
fn corrupt_or_foreign_manifest_fails_closed() {
    let home = TestDir::new();
    fs::write(manifest_path(&home.0), b"{broken").unwrap();
    assert!(load(&home.0, &identity()).unwrap_err().contains("corrupt"));
    let mut foreign = WorkspaceManifest::new(&identity()).unwrap();
    foreign.account_sub = "another-sub".into();
    fs::write(manifest_path(&home.0), serde_json::to_vec(&foreign).unwrap()).unwrap();
    assert!(load(&home.0, &identity()).unwrap_err().contains("identity"));
}

#[test]
fn corrupt_primary_with_valid_backup_blocks_mutations_without_losing_tombstones() {
    let home = TestDir::new();
    let mut manifest = WorkspaceManifest::new(&identity()).unwrap();
    manifest.revision = 3;
    manifest.folder_id = Some("known-folder".into());
    fs::write(manifest_path(&home.0), b"{broken").unwrap();
    fs::write(manifest_path(&home.0).with_extension("json.bak"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(load(&home.0, &identity()).unwrap_err().contains("requires explicit recovery"));
    assert_eq!(fs::read(manifest_path(&home.0)).unwrap(), b"{broken");
    let restored: WorkspaceManifest = serde_json::from_slice(
        &fs::read(manifest_path(&home.0).with_extension("json.bak")).unwrap()).unwrap();
    assert_eq!(restored, manifest);
    let mut other = identity();
    other.account_sub = "wrong-account".into();
    assert!(load(&home.0, &other).is_err());
}

#[test]
fn manifest_rejects_path_components_and_duplicate_deletions() {
    let home = TestDir::new();
    let mut manifest = WorkspaceManifest::new(&identity()).unwrap();
    manifest.files.insert("../escape.md".into(), WorkspaceFile {
        drive_id: "remote-1".into(), digest: "digest".into(), note_id: "note-1".into(),
    });
    fs::write(manifest_path(&home.0), serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(load(&home.0, &identity()).unwrap_err().contains("invalid remote identity"));
    manifest.files.clear();
    for name in ["A.md", "B.md"] {
        manifest.pending_deletions.insert(name.into(), WorkspaceTombstone {
            drive_id: "same-remote".into(), note_id: format!("note-{name}"),
        });
    }
    fs::write(manifest_path(&home.0), serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(load(&home.0, &identity()).unwrap_err().contains("duplicates a remote deletion"));
}
