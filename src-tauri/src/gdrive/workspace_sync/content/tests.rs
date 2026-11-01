use super::*;
use crate::gdrive::auth::{TokenProvider, TokenRefreshError};
use crate::workspaces::sync_context::{Admission, SyncCoordinator};
use crate::workspaces::{management, migration::Faults, snapshot, types::WorkspaceKind};
use std::future::Future;
use std::sync::Arc;

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("lyra-f4-content-{:032x}", rand::random::<u128>()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

struct FakeToken;
impl TokenProvider for FakeToken {
    fn get_token(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>> {
        Box::pin(async { Ok("fake-token".into()) })
    }
    fn refresh_token(&self, _: &str) -> std::pin::Pin<Box<dyn Future<Output = Result<String, TokenRefreshError>> + Send + '_>> {
        Box::pin(async { Err(TokenRefreshError::Other("unused".into())) })
    }
}

fn workspace() -> (TestDir, Ctx, SyncRequest, WorkspaceIdentity, PathBuf) {
    let home = TestDir::new();
    let documents = home.0.join("Documents");
    let config = home.0.join("config");
    fs::create_dir_all(documents.join("lyra")).unwrap();
    fs::create_dir_all(&config).unwrap();
    snapshot(&documents, &config, &Faults::none()).unwrap();
    let ctx = Ctx::new(documents, config);
    let id = management::create_with_kind(&ctx, "Drive", WorkspaceKind::GoogleDrive).unwrap();
    management::select(&ctx, &id).unwrap();
    management::bind_drive_account(&ctx, &id, "verified-sub", "fake@example.test").unwrap();
    let request = sync_context::current(&ctx.documents, &ctx.config).unwrap();
    let (identity, notes_dir) = super::super::resolve_identity(&ctx, &request).unwrap();
    (home, ctx, request, identity, notes_dir)
}

fn owner<'a>(coordinator: &'a SyncCoordinator, request: &SyncRequest) -> SyncPermit<'a> {
    match coordinator.submit(request.clone(), request).unwrap() {
        Admission::Active(owner) => owner,
        Admission::Queued => panic!("expected owner"),
    }
}

fn client_and_server<F>(handler: F) -> (DriveClient, std::thread::JoinHandle<()>)
where F: FnOnce(tiny_http::Server) + Send + 'static {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
    let handle = std::thread::spawn(move || handler(server));
    (DriveClient::new_with_provider_and_base_url(Arc::new(FakeToken), base).unwrap(), handle)
}

fn respond_generated_id(server: &tiny_http::Server, id: &str) {
    let request = server.recv().unwrap();
    assert_eq!(request.method(), &tiny_http::Method::Get);
    assert!(request.url().contains("generateIds"));
    request.respond(tiny_http::Response::from_string(
        serde_json::json!({"ids": [id]}).to_string())).unwrap();
}

fn remote(id: &str, name: &str, content: &[u8]) -> DriveFileMetadata {
    serde_json::from_value(serde_json::json!({
        "id": id, "name": name, "mimeType": "text/markdown", "md5Checksum": digest(content),
        "parents": ["folder"],
    })).unwrap()
}

#[tokio::test]
async fn remote_download_collision_preserves_the_existing_local_note() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    let (client, server) = client_and_server(|server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        assert!(request.url().contains("remote-note"));
        request.respond(tiny_http::Response::from_data(b"remote".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let name = session.download_new(&remote("remote-note", "Note.md", b"remote")).await.unwrap();
    assert_ne!(name, "Note.md");
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"local");
    assert_eq!(fs::read(notes_dir.join(&name)).unwrap(), b"remote");
    let manifest = load(&notes_dir, &identity).unwrap();
    assert_eq!(manifest.files[&name].drive_id, "remote-note");
    assert_eq!(manifest.remote_names[&name], "Note.md");
    assert_eq!(manifest.conflicts[&name], "Note.md");
    server.join().unwrap();
}

#[tokio::test]
async fn divergent_download_preserves_both_versions_without_creating_untracked_copies() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"baseline", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "remote-note".into(), digest: digest(b"baseline"), note_id,
        });
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    sync::write_file_atomic(&notes_dir.join("Note.md"), b"local edit").unwrap();
    provenance::record_local_write(&notes_dir, "Note.md", None, false).unwrap();
    let (client, server) = client_and_server(|server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_data(b"remote edit".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let item = load(&notes_dir, &identity).unwrap().files["Note.md"].clone();
    let local = session.snapshot("Note.md").await.unwrap();
    assert!(session.download_mapped("Note.md", &item, local,
        &remote("remote-note", "Note.md", b"remote edit")).await
        .unwrap_err().contains("Concurrent local and remote edits"));
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"local edit");
    assert_eq!(local_note_names(&notes_dir).unwrap(), ["Note.md"]);
    assert_eq!(load(&notes_dir, &identity).unwrap().files["Note.md"].digest, digest(b"baseline"));
    server.join().unwrap();
}

#[tokio::test]
async fn cancelled_upload_does_not_confirm_manifest_and_can_be_recovered_by_note_id() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let nonce = identity.folder_nonce.clone();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    let (client, server) = client_and_server(move |server| {
        respond_generated_id(&server, "uploaded-id");
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        let _ = entered_tx.send(());
        release_rx.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "id": "uploaded-id", "name": "Note.md", "mimeType": "text/markdown",
            "parents": ["folder"],
            "appProperties": {"lyra_workspace_nonce": nonce, "lyra_note_id": note_id},
        }).to_string())).unwrap();
    });
    let coordinator = Arc::new(SyncCoordinator::default());
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request.clone(), || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    let coordinator_for_cancel = Arc::clone(&coordinator);
    let request_for_cancel = request.clone();
    let cancel = tokio::spawn(async move {
        entered_rx.await.unwrap();
        let transition = coordinator_for_cancel.begin_transition();
        tokio::pin!(transition);
        tokio::select! { biased; _ = &mut transition => panic!("HTTP must finish first"),
            _ = std::future::ready(()) => {} }
        while coordinator_for_cancel.is_owner(&request_for_cancel) { tokio::task::yield_now().await; }
        release_tx.send(()).unwrap();
        drop(transition.await.unwrap());
    });
    assert!(session.upload_new("Note.md", local, &BTreeMap::new(), None).await
        .unwrap_err().contains("SyncStale"));
    cancel.await.unwrap();
    assert!(load(&notes_dir, &identity).unwrap().files.is_empty());
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"local");
    server.join().unwrap();
}

#[tokio::test]
async fn initial_content_sync_uses_the_workspace_folder_and_upload_identity() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    let nonce = identity.folder_nonce.clone();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    let (client, server) = client_and_server(move |server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        assert!(request.url().contains("lyra_workspace_nonce"));
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "folder", "mimeType": "application/vnd.google-apps.folder",
                "appProperties": {"lyra_workspace_nonce": nonce}}]
        }).to_string())).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        assert!(request.url().contains("folder"));
        request.respond(tiny_http::Response::from_string(r#"{"files":[]}"#)).unwrap();
        respond_generated_id(&server, "uploaded-note");
        let mut request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        assert!(request.url().contains("uploadType=multipart"));
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        assert!(body.contains("lyra_note_id"));
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "id": "uploaded-note", "name": "Note.md", "mimeType": "text/markdown",
            "parents": ["folder"],
            "md5Checksum": digest(b"local"),
            "appProperties": {"lyra_workspace_nonce": nonce, "lyra_note_id": note_id}
        }).to_string())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let result = session.run().await.unwrap();
    assert_eq!(result.uploaded, ["Note.md"]);
    assert_eq!(load(&notes_dir, &identity).unwrap().files["Note.md"].drive_id, "uploaded-note");
    server.join().unwrap();
}

#[tokio::test]
async fn initial_remote_note_downloads_without_a_legacy_manifest() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    let nonce = identity.folder_nonce.clone();
    let (client, server) = client_and_server(move |server| {
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "folder", "mimeType": "application/vnd.google-apps.folder",
                "appProperties": {"lyra_workspace_nonce": nonce}}]
        }).to_string())).unwrap();
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "remote-note", "name": "Remote.md", "mimeType": "text/markdown",
                "md5Checksum": digest(b"remote")}]
        }).to_string())).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        assert!(request.url().contains("remote-note"));
        request.respond(tiny_http::Response::from_data(b"remote".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let result = session.run().await.unwrap();
    assert_eq!(result.downloaded, ["Remote.md"]);
    assert_eq!(fs::read(notes_dir.join("Remote.md")).unwrap(), b"remote");
    assert_eq!(load(&notes_dir, &identity).unwrap().files["Remote.md"].drive_id, "remote-note");
    server.join().unwrap();
}

#[tokio::test]
async fn initial_name_collision_preserves_both_notes_and_blocks_remote_rename() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    let nonce = identity.folder_nonce.clone();
    let (client, server) = client_and_server(move |server| {
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "folder", "mimeType": "application/vnd.google-apps.folder",
                "appProperties": {"lyra_workspace_nonce": nonce}}]
        }).to_string())).unwrap();
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "remote-note", "name": "Note.md", "mimeType": "text/markdown",
                "md5Checksum": digest(b"remote")}]
        }).to_string())).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_data(b"remote".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let error = session.run().await.unwrap_err();
    assert!(error.contains("collision"));
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"local");
    let manifest = load(&notes_dir, &identity).unwrap();
    let conflict = manifest.conflicts.keys().next().unwrap();
    assert_eq!(fs::read(notes_dir.join(conflict)).unwrap(), b"remote");
    assert_eq!(manifest.remote_names[conflict], "Note.md");
    server.join().unwrap();
}

#[tokio::test]
async fn interrupted_local_rename_is_reconciled_by_note_id() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Old.md", b"content", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Old.md"].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("Old.md".into(), WorkspaceFile {
            drive_id: "remote".into(), digest: digest(b"content"), note_id: note_id.clone(),
        });
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    fs::rename(notes_dir.join("Old.md"), notes_dir.join("New.md")).unwrap();
    assert!(provenance::rename_note(&notes_dir, "Old.md", "New.md").unwrap());
    let client = DriveClient::new_with_provider_and_base_url(Arc::new(FakeToken),
        "http://127.0.0.1:1".into()).unwrap();
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    session.reconcile_interrupted_local_renames().await.unwrap();
    let manifest = load(&notes_dir, &identity).unwrap();
    assert!(!manifest.files.contains_key("Old.md"));
    assert_eq!(manifest.files["New.md"].note_id, note_id);
    assert_eq!(manifest.pending_renames["New.md"], "Old.md");
}

#[tokio::test]
async fn remote_rename_preserves_intent_without_a_folder_precondition() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "New.md", b"content", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["New.md"].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("New.md".into(), WorkspaceFile {
            drive_id: "remote".into(), digest: digest(b"content"), note_id,
        });
        manifest.pending_renames.insert("New.md".into(), "Old.md".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let client = DriveClient::new_with_provider_and_base_url(Arc::new(FakeToken),
        "http://127.0.0.1:1".into()).unwrap();
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let remote = remote("remote", "Old.md", b"content");
    let index = BTreeMap::from([("remote".into(), remote.clone())]);
    let error = session.flush_rename("New.md", "Old.md", &remote, &index).await.unwrap_err();
    assert!(error.contains("SyncPaused"));
    assert_eq!(load(&notes_dir, &identity).unwrap().pending_renames["New.md"], "Old.md");
}

#[tokio::test]
async fn orphan_upload_without_durable_intent_requires_manual_resolution() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    let nonce = identity.folder_nonce.clone();
    let (client, server) = client_and_server(move |server| {
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "folder", "mimeType": "application/vnd.google-apps.folder",
                "appProperties": {"lyra_workspace_nonce": nonce}}]
        }).to_string())).unwrap();
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "orphan-upload", "name": "Note.md", "mimeType": "text/markdown",
                "md5Checksum": digest(b"local"),
                "parents": ["folder"],
                "appProperties": {"lyra_workspace_nonce": nonce, "lyra_note_id": note_id}}]
        }).to_string())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    assert!(session.run().await.unwrap_err().contains("no durable upload intent"));
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"local");
    assert!(load(&notes_dir, &identity).unwrap().files.is_empty());
    server.join().unwrap();
}

#[tokio::test]
async fn late_download_after_workspace_cancellation_writes_no_local_note() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (client, server) = client_and_server(move |server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        let _ = entered_tx.send(());
        release_rx.recv().unwrap();
        request.respond(tiny_http::Response::from_data(b"remote".to_vec())).unwrap();
    });
    let coordinator = Arc::new(SyncCoordinator::default());
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request.clone(), || Ok(()), &client, &permit).unwrap();
    let cancellation = {
        let coordinator = Arc::clone(&coordinator);
        let request = request.clone();
        let switched_ctx = ctx.clone();
        tokio::spawn(async move {
            entered_rx.await.unwrap();
            let transition = coordinator.begin_transition();
            tokio::pin!(transition);
            tokio::select! { biased; _ = &mut transition => panic!("HTTP must finish first"),
                _ = std::future::ready(()) => {} }
            while coordinator.is_owner(&request) { tokio::task::yield_now().await; }
            release_tx.send(()).unwrap();
            let critical = transition.await.unwrap();
            management::select(&switched_ctx, "ws_001").unwrap();
            drop(critical);
        })
    };
    assert!(session.download_new(&remote("remote-note", "Note.md", b"remote")).await
        .unwrap_err().contains("SyncStale"));
    cancellation.await.unwrap();
    assert!(!notes_dir.join("Note.md").exists());
    assert!(load(&notes_dir, &identity).unwrap().files.is_empty());
    assert!(!ctx.documents.join("lyra/workspaces/ws_001/Note.md").exists());
    server.join().unwrap();
}

#[tokio::test]
async fn upload_network_error_leaves_local_content_and_manifest_unmodified() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let (client, server) = client_and_server(|server| {
        respond_generated_id(&server, "uploaded-id");
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        request.respond(tiny_http::Response::from_string("bad request").with_status_code(400)).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    assert!(session.upload_new("Note.md", local, &BTreeMap::new(), None).await.is_err());
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"local");
    assert!(load(&notes_dir, &identity).unwrap().files.is_empty());
    server.join().unwrap();
}

#[tokio::test]
async fn manifest_change_during_http_cannot_confirm_an_obsolete_upload() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    let nonce = identity.folder_nonce.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (client, server) = client_and_server(move |server| {
        respond_generated_id(&server, "uploaded-id");
        let request = server.recv().unwrap();
        let _ = entered_tx.send(());
        release_rx.recv().unwrap();
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "id": "uploaded-id", "name": "Note.md", "mimeType": "text/markdown",
            "parents": ["folder"],
            "md5Checksum": digest(b"local"),
            "appProperties": {"lyra_workspace_nonce": nonce, "lyra_note_id": note_id},
        }).to_string())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    let mutate = async {
        entered_rx.await.unwrap();
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        let revision = manifest.revision;
        manifest.pending_uploads.remove("Note.md");
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "newer-mapping".into(), digest: digest(b"local"), note_id: "newer-note".into(),
        });
        save_locked(&notes_dir, &identity, revision, manifest, &guard).unwrap();
        release_tx.send(()).unwrap();
    };
    let empty_index = BTreeMap::new();
    let (uploaded, ()) = tokio::join!(session.upload_new("Note.md", local, &empty_index, None), mutate);
    let error = uploaded.unwrap_err();
    assert!(error.contains("changed") || error.contains("intent"), "{error}");
    assert_eq!(load(&notes_dir, &identity).unwrap().files["Note.md"].drive_id, "newer-mapping");
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"local");
    server.join().unwrap();
}

#[tokio::test]
async fn existing_remote_update_stops_before_http_without_a_proven_precondition() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"old", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    let item = WorkspaceFile {
        drive_id: "remote-note".into(), digest: digest(b"old"), note_id,
    };
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("Note.md".into(), item.clone());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    sync::write_file_atomic(&notes_dir.join("Note.md"), b"new local content").unwrap();
    provenance::record_local_write(&notes_dir, "Note.md", None, false).unwrap();
    let client = DriveClient::new_with_provider_and_base_url(Arc::new(FakeToken),
        "http://127.0.0.1:1".into()).unwrap();
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    let mut index = BTreeMap::new();
    index.insert("remote-note".into(), remote("remote-note", "Note.md", b"other client edit"));
    let error = session.upload_new("Note.md", local, &index, Some(&item)).await.unwrap_err();
    assert!(!error.is_empty());
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"new local content");
    assert_eq!(load(&notes_dir, &identity).unwrap().files["Note.md"], item);
}

#[tokio::test]
async fn dispatched_upload_retries_the_same_id_after_lost_response() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let (client, server) = client_and_server(|server| {
        respond_generated_id(&server, "created-id");
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        // The server has accepted the create, but the connection closes
        // before the client receives its ID.
        drop(request);
    });
    {
        let coordinator = SyncCoordinator::default();
        let permit = owner(&coordinator, &request);
        let session = ContentSession::new(&ctx, request.clone(), || Ok(()), &client, &permit).unwrap();
        let local = session.snapshot("Note.md").await.unwrap().unwrap();
        assert!(session.upload_new("Note.md", local, &BTreeMap::new(), None).await.is_err());
    }
    server.join().unwrap();
    let intent = load(&notes_dir, &identity).unwrap().pending_uploads["Note.md"].clone();
    assert_eq!(intent.phase, UploadPhase::Dispatched);
    assert_eq!(intent.remote_id.as_deref(), Some("created-id"));
    let nonce = identity.folder_nonce.clone();
    let note_id = intent.note_id.clone();
    let (client, server) = client_and_server(move |server| {
        let mut request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        assert!(body.contains("\"id\":\"created-id\""));
        request.respond(tiny_http::Response::from_string("already exists").with_status_code(409)).unwrap();
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        assert!(request.url().contains("created-id"));
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "id": "created-id", "name": "Note.md", "mimeType": "text/markdown",
            "md5Checksum": digest(b"local"), "parents": ["folder"],
            "appProperties": {"lyra_workspace_nonce": nonce, "lyra_note_id": note_id},
            "trashed": false
        }).to_string())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    assert!(session.upload_new("Note.md", local, &BTreeMap::new(), None).await.unwrap());
    server.join().unwrap();
    let manifest = load(&notes_dir, &identity).unwrap();
    assert_eq!(manifest.files["Note.md"].drive_id, "created-id");
    assert!(manifest.pending_uploads.is_empty());
}

#[tokio::test]
async fn timeout_after_server_accepts_create_keeps_dispatched_intent() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (client, server) = client_and_server(move |server| {
        respond_generated_id(&server, "timeout-id");
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        accepted_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        drop(request);
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    let empty_index = BTreeMap::new();
    let upload = session.upload_new("Note.md", local, &empty_index, None);
    tokio::pin!(upload);
    tokio::select! {
        accepted = accepted_rx => { accepted.unwrap(); }
        result = &mut upload => panic!("Upload finished before server acceptance: {result:?}"),
    }
    assert!(tokio::time::timeout(std::time::Duration::from_millis(20), &mut upload).await.is_err());
    drop(upload);
    release_tx.send(()).unwrap();
    server.join().unwrap();
    let manifest = load(&notes_dir, &identity).unwrap();
    assert!(manifest.files.is_empty());
    assert_eq!(manifest.pending_uploads["Note.md"].phase, UploadPhase::Dispatched);
    assert_eq!(manifest.pending_uploads["Note.md"].remote_id.as_deref(), Some("timeout-id"));
}

#[tokio::test]
async fn prepared_upload_can_resume_after_restart_before_http() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"local", None).unwrap();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let (generator, generation_server) = client_and_server(|server| {
        respond_generated_id(&server, "created-id");
    });
    {
        let coordinator = SyncCoordinator::default();
        let permit = owner(&coordinator, &request);
        let session = ContentSession::new(&ctx, request.clone(), || Ok(()), &generator, &permit).unwrap();
        let local = session.snapshot("Note.md").await.unwrap().unwrap();
        session.prepare_upload("Note.md", &local, None).await.unwrap();
    }
    generation_server.join().unwrap();
    assert_eq!(load(&notes_dir, &identity).unwrap().pending_uploads["Note.md"].phase,
        UploadPhase::Prepared);
    let nonce = identity.folder_nonce.clone();
    let note_id = load(&notes_dir, &identity).unwrap().pending_uploads["Note.md"].note_id.clone();
    let (client, server) = client_and_server(move |server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        request.respond(tiny_http::Response::from_string(serde_json::json!({
            "id": "created-id", "name": "Note.md", "mimeType": "text/markdown",
            "parents": ["folder"],
            "md5Checksum": digest(b"local"),
            "appProperties": {"lyra_workspace_nonce": nonce, "lyra_note_id": note_id}
        }).to_string())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    assert!(session.upload_new("Note.md", local, &BTreeMap::new(), None).await.unwrap());
    server.join().unwrap();
    assert!(load(&notes_dir, &identity).unwrap().pending_uploads.is_empty());
}

#[tokio::test]
async fn downloaded_note_is_adopted_after_restart_without_creating_a_duplicate() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    let planned = DownloadIntent { name: "Remote.md".into(),
        note_id: provenance::new_note_id(), digest: digest(b"remote") };
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.pending_downloads.insert("remote-id".into(), planned.clone());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    provenance::create_local_note_with_id(&notes_dir, "Remote.md", b"remote", &planned.note_id).unwrap();
    let (client, server) = client_and_server(|server| {
        let request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Get);
        request.respond(tiny_http::Response::from_data(b"remote".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    assert_eq!(session.download_new(&remote("remote-id", "Remote.md", b"remote")).await.unwrap(), "Remote.md");
    server.join().unwrap();
    let manifest = load(&notes_dir, &identity).unwrap();
    assert_eq!(manifest.files["Remote.md"].note_id, planned.note_id);
    assert!(manifest.pending_downloads.is_empty());
    assert_eq!(local_note_names(&notes_dir).unwrap(), ["Remote.md"]);
}

#[tokio::test]
async fn ambiguous_download_target_keeps_intent_and_does_not_overwrite() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    let planned = DownloadIntent { name: "Remote.md".into(),
        note_id: provenance::new_note_id(), digest: digest(b"remote") };
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.pending_downloads.insert("remote-id".into(), planned);
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    provenance::create_local_note(&notes_dir, "Remote.md", b"remote", None).unwrap();
    let (client, server) = client_and_server(|server| {
        let request = server.recv().unwrap();
        request.respond(tiny_http::Response::from_data(b"remote".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    assert!(session.download_new(&remote("remote-id", "Remote.md", b"remote")).await
        .unwrap_err().contains("ambiguous"));
    server.join().unwrap();
    assert_eq!(fs::read(notes_dir.join("Remote.md")).unwrap(), b"remote");
    assert!(load(&notes_dir, &identity).unwrap().pending_downloads.contains_key("remote-id"));
    assert_eq!(local_note_names(&notes_dir).unwrap(), ["Remote.md"]);
}

#[tokio::test]
async fn edited_note_creates_immutable_version_and_keeps_previous_id() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"new", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    let previous = WorkspaceFile { drive_id: "old-id".into(), digest: digest(b"old"), note_id: note_id.clone() };
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("Note.md".into(), previous.clone());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let nonce = identity.folder_nonce.clone();
    let (client, server) = client_and_server(move |server| {
        respond_generated_id(&server, "new-id");
        let mut req = server.recv().unwrap();
        assert_eq!(req.method(), &tiny_http::Method::Post);
        assert!(req.url().contains("uploadType=multipart"));
        let mut body = String::new();
        req.as_reader().read_to_string(&mut body).unwrap();
        assert!(body.contains("\"id\":\"new-id\""));
        assert!(body.contains("\"lyra_previous_id\":\"old-id\""));
        req.respond(tiny_http::Response::from_string(serde_json::json!({
            "id": "new-id", "name": "Note.md", "mimeType": "text/markdown",
            "parents": ["folder"], "md5Checksum": digest(b"new"),
            "appProperties": {"lyra_workspace_nonce": nonce, "lyra_note_id": note_id,
                "lyra_previous_id": "old-id"}
        }).to_string())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let local = session.snapshot("Note.md").await.unwrap().unwrap();
    let mut index = BTreeMap::new();
    index.insert("old-id".into(), remote("old-id", "Note.md", b"old"));
    assert!(session.upload_new("Note.md", local, &index, Some(&previous)).await.unwrap());
    server.join().unwrap();
    let manifest = load(&notes_dir, &identity).unwrap();
    assert_eq!(manifest.files["Note.md"].drive_id, "new-id");
    assert_eq!(manifest.historical_versions["old-id"], digest(b"old"));
    assert_eq!(manifest.archive_anchors["new-id"], "old-id");
    assert!(manifest.pending_uploads.is_empty());
}

#[tokio::test]
async fn remote_index_keeps_concurrent_versions_with_the_same_note_id() {
    let (_home, ctx, request, identity, _notes_dir) = workspace();
    let client = DriveClient::new_with_provider_and_base_url(Arc::new(FakeToken),
        "http://127.0.0.1:1".into()).unwrap();
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let mut first = remote("version-a", "Note.md", b"a");
    first.app_properties.insert("lyra_note_id".into(), "note-1".into());
    first.app_properties.insert("lyra_workspace_nonce".into(), identity.folder_nonce.clone());
    let mut second = remote("version-b", "Note.md", b"b");
    second.app_properties = first.app_properties.clone();
    let index = session.index_remote(vec![first, second]).unwrap();
    assert_eq!(index.len(), 2);
    assert_ne!(index["version-a"].md5_checksum, index["version-b"].md5_checksum);
}

#[tokio::test]
async fn unedited_device_applies_unique_immutable_successor_without_conflict() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"old", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "old-id".into(), digest: digest(b"old"), note_id: note_id.clone(),
        });
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let nonce = identity.folder_nonce.clone();
    let (client, server) = client_and_server(move |server| {
        let req = server.recv().unwrap();
        req.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "folder", "mimeType": "application/vnd.google-apps.folder",
                "appProperties": {"lyra_workspace_nonce": nonce}}]
        }).to_string())).unwrap();
        let req = server.recv().unwrap();
        req.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [
                {"id": "old-id", "name": "Note.md", "mimeType": "text/markdown",
                    "parents": ["folder"], "md5Checksum": digest(b"old")},
                {"id": "new-id", "name": "Note.md", "mimeType": "text/markdown",
                    "parents": ["folder"], "md5Checksum": digest(b"new"),
                    "appProperties": {"lyra_workspace_nonce": nonce,
                        "lyra_note_id": note_id, "lyra_previous_id": "old-id"}}
            ]
        }).to_string())).unwrap();
        let req = server.recv().unwrap();
        assert!(req.url().contains("new-id"));
        req.respond(tiny_http::Response::from_data(b"new".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let result = session.run().await.unwrap();
    server.join().unwrap();
    assert!(result.conflicts.is_empty());
    assert_eq!(result.downloaded, ["Note.md"]);
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"new");
    let manifest = load(&notes_dir, &identity).unwrap();
    assert_eq!(manifest.files["Note.md"].drive_id, "new-id");
    assert_eq!(manifest.archive_anchors["new-id"], "old-id");
    assert_eq!(manifest.historical_versions["old-id"], digest(b"old"));
}

#[tokio::test]
async fn concurrent_successors_preserve_original_and_both_conflict_copies() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"old", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "old-id".into(), digest: digest(b"old"), note_id: note_id.clone(),
        });
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let nonce = identity.folder_nonce.clone();
    let (client, server) = client_and_server(move |server| {
        let req = server.recv().unwrap();
        req.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [{"id": "folder", "mimeType": "application/vnd.google-apps.folder",
                "appProperties": {"lyra_workspace_nonce": nonce}}]
        }).to_string())).unwrap();
        let req = server.recv().unwrap();
        req.respond(tiny_http::Response::from_string(serde_json::json!({
            "files": [
                {"id": "old-id", "name": "Note.md", "mimeType": "text/markdown",
                    "parents": ["folder"], "md5Checksum": digest(b"old")},
                {"id": "branch-a", "name": "Note.md", "mimeType": "text/markdown",
                    "parents": ["folder"], "md5Checksum": digest(b"a"),
                    "appProperties": {"lyra_workspace_nonce": nonce,
                        "lyra_note_id": note_id, "lyra_previous_id": "old-id"}},
                {"id": "branch-b", "name": "Note.md", "mimeType": "text/markdown",
                    "parents": ["folder"], "md5Checksum": digest(b"b"),
                    "appProperties": {"lyra_workspace_nonce": nonce,
                        "lyra_note_id": note_id, "lyra_previous_id": "old-id"}}
            ]
        }).to_string())).unwrap();
        for _ in 0..2 {
            let req = server.recv().unwrap();
            let bytes: &[u8] = if req.url().contains("branch-a") { b"a" } else { b"b" };
            req.respond(tiny_http::Response::from_data(bytes.to_vec())).unwrap();
        }
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let result = session.run().await.unwrap();
    server.join().unwrap();
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"old");
    assert_eq!(result.conflicts.len(), 2);
    let manifest = load(&notes_dir, &identity).unwrap();
    assert_eq!(manifest.files["Note.md"].drive_id, "old-id");
    assert_eq!(manifest.conflicts.len(), 2);
    for name in result.conflicts {
        assert!(notes_dir.join(&name).is_file());
        assert_eq!(manifest.remote_names[&name], "Note.md");
    }
}

#[tokio::test]
async fn explicitly_renamed_conflict_keeps_remote_copy_and_clears_notice() {
    let (_home, _ctx, _request, identity, notes_dir) = workspace();
    let old_name = "Note (Drive conflict 1).md";
    provenance::create_local_note(&notes_dir, old_name, b"version b", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name[old_name].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.files.insert(old_name.into(), WorkspaceFile {
            drive_id: "branch-b".into(), digest: digest(b"version b"), note_id,
        });
        manifest.remote_names.insert(old_name.into(), "Note.md".into());
        manifest.conflicts.insert(old_name.into(), "Note.md".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    fs::rename(notes_dir.join(old_name), notes_dir.join("My version.md")).unwrap();
    assert!(provenance::rename_note(&notes_dir, old_name, "My version.md").unwrap());
    let guard = MANIFEST_LOCK.lock().await;
    super::super::record_local_rename(&notes_dir, &identity, old_name, "My version.md", &guard).unwrap();
    let manifest = load(&notes_dir, &identity).unwrap();
    assert!(manifest.conflicts.is_empty());
    assert_eq!(manifest.remote_names["My version.md"], "Note.md");
    assert_eq!(manifest.files["My version.md"].drive_id, "branch-b");
    assert!(manifest.pending_renames.is_empty());
    assert_eq!(fs::read(notes_dir.join("My version.md")).unwrap(), b"version b");
}

#[tokio::test]
async fn divergent_historical_version_keeps_archive_anchor_when_imported() {
    let (_home, ctx, request, identity, notes_dir) = workspace();
    provenance::create_local_note(&notes_dir, "Note.md", b"new", None).unwrap();
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir)).unwrap()
        .unwrap().by_name["Note.md"].clone();
    {
        let guard = MANIFEST_LOCK.lock().await;
        let mut manifest = load(&notes_dir, &identity).unwrap();
        manifest.folder_id = Some("folder".into());
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "new-id".into(), digest: digest(b"new"), note_id,
        });
        manifest.historical_versions.insert("old-id".into(), digest(b"old"));
        manifest.archive_anchors.insert("new-id".into(), "old-id".into());
        save_locked(&notes_dir, &identity, 0, manifest, &guard).unwrap();
    }
    let (client, server) = client_and_server(|server| {
        let req = server.recv().unwrap();
        assert!(req.url().contains("old-id"));
        req.respond(tiny_http::Response::from_data(b"other edit".to_vec())).unwrap();
    });
    let coordinator = SyncCoordinator::default();
    let permit = owner(&coordinator, &request);
    let session = ContentSession::new(&ctx, request, || Ok(()), &client, &permit).unwrap();
    let name = session.download_new(&remote("old-id", "Note.md", b"other edit")).await.unwrap();
    server.join().unwrap();
    assert_ne!(name, "Note.md");
    assert_eq!(fs::read(notes_dir.join("Note.md")).unwrap(), b"new");
    let manifest = load(&notes_dir, &identity).unwrap();
    assert_eq!(manifest.archive_anchors["new-id"], "old-id");
    assert_eq!(manifest.historical_versions["old-id"], digest(b"old"));
    assert_eq!(manifest.files[&name].drive_id, "old-id");
}
