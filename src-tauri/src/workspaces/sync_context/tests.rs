use super::*;
use crate::workspaces::{
    management,
    migration::{Ctx, Faults},
    snapshot,
};
use std::fs;
use std::sync::Arc;
use tokio::sync::oneshot;

fn request(id: &str, epoch: u64) -> SyncRequest {
    SyncRequest {
        workspace_id: id.into(),
        epoch,
    }
}

fn active<'a>(coordinator: &'a SyncCoordinator, request: SyncRequest) -> SyncPermit<'a> {
    match coordinator.submit(request.clone(), &request).unwrap() {
        Admission::Active(permit) => permit,
        Admission::Queued => panic!("expected an active owner"),
    }
}

fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("lyra-f3-{:032x}", rand::random::<u128>()));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn local_workspace_is_resolved_by_id_and_epoch_without_legacy_fallback() {
    let root = temp_root();
    let documents = root.join("Documents");
    let config = root.join("config");
    fs::create_dir_all(documents.join("lyra")).unwrap();
    fs::create_dir_all(&config).unwrap();
    snapshot(&documents, &config, &Faults::none()).unwrap();
    let current = current(&documents, &config).unwrap();
    let resolved = resolve(&documents, &config, &current).unwrap();
    assert_eq!(resolved.kind, WorkspaceKind::Local);
    assert!(sync_gate(resolved.kind)
        .unwrap_err()
        .starts_with("SyncDisabled"));
    assert!(sync_gate(WorkspaceKind::GoogleDrive)
        .unwrap_err()
        .starts_with("SyncPaused"));
    assert_eq!(resolved.notes_dir, documents.join("lyra/workspaces/ws_001"));
    assert!(resolve(&documents, &config, &request("ws_001", current.epoch + 1)).is_err());
    assert!(resolve(&documents, &config, &request("ws_002", current.epoch)).is_err());
    let ctx = Ctx::new(documents.clone(), config.clone());
    let second = management::create(&ctx, "Other").unwrap();
    management::select(&ctx, &second).unwrap();
    assert!(resolve(&documents, &config, &current)
        .unwrap_err()
        .contains("SyncStale"));
    assert_eq!(
        resolve(
            &documents,
            &config,
            &super::current(&documents, &config).unwrap()
        )
        .unwrap()
        .notes_dir,
        documents.join("lyra/workspaces/ws_002")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn sync_events_carry_flat_workspace_identity_and_epoch() {
    let payload = SyncEvent::new(
        &request("ws_002", 9),
        serde_json::json!({"sync_id": "sync-1"}),
    );
    let value = serde_json::to_value(payload).unwrap();
    assert_eq!(value["workspace_id"], "ws_002");
    assert_eq!(value["epoch"], 9);
    assert_eq!(value["sync_id"], "sync-1");
}

#[test]
fn f3_concurrency_queue_drops_stale_epoch_and_releases_owner_for_retry() {
    let coordinator = SyncCoordinator::default();
    let first = request("ws_001", 1);
    let later = request("ws_002", 2);
    let owner = active(&coordinator, first.clone());
    assert!(matches!(
        coordinator.submit(first.clone(), &first).unwrap(),
        Admission::Queued
    ));
    assert!(coordinator.submit(later.clone(), &first).is_err());
    assert!(owner.finish(&later).is_none());
    let retry = active(&coordinator, later.clone());
    assert!(coordinator.is_owner(&later));
    drop(retry);
    assert!(!coordinator.is_owner(&later));
    assert!(matches!(
        coordinator.submit(later.clone(), &later).unwrap(),
        Admission::Active(_)
    ));
}

#[test]
fn f3_concurrency_two_requests_promote_only_the_current_trailing_owner() {
    let coordinator = SyncCoordinator::default();
    let request = request("ws_001", 3);
    let owner = active(&coordinator, request.clone());
    assert!(matches!(
        coordinator.submit(request.clone(), &request).unwrap(),
        Admission::Queued
    ));
    let trailing = owner.finish(&request).expect("current trailing request");
    assert!(coordinator.is_owner(&request));
    drop(trailing);
    assert!(!coordinator.is_owner(&request));
}

#[tokio::test]
async fn f3_concurrency_cancel_before_manifest_commit_prevents_write() {
    let coordinator = SyncCoordinator::default();
    let first = request("ws_001", 1);
    let next = request("ws_002", 2);
    let current = Arc::new(Mutex::new(first.clone()));
    let permit = active(&coordinator, first);
    let root = temp_root();
    let manifest = root.join("manifest.json");
    let transition = coordinator.begin_transition().await.unwrap();
    *current.lock().unwrap() = next;
    drop(transition);
    let result = permit
        .effect(
            || Ok(current.lock().unwrap().clone()),
            || async { fs::write(&manifest, b"stale").map_err(|e| e.to_string()) },
        )
        .await;
    assert!(result.unwrap_err().contains("SyncStale"));
    assert!(!manifest.exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn f3_concurrency_download_finishes_in_origin_before_switch_and_never_writes_other_space() {
    let coordinator = SyncCoordinator::default();
    let first = request("ws_001", 1);
    let next = request("ws_002", 2);
    let current = Arc::new(Mutex::new(first.clone()));
    let permit = active(&coordinator, first.clone());
    let root = temp_root();
    let origin = root.join("ws_001/note.md");
    let other = root.join("ws_002/note.md");
    fs::create_dir_all(origin.parent().unwrap()).unwrap();
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    let (entered_tx, entered_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let effect = permit.effect(
        || Ok(current.lock().unwrap().clone()),
        || async {
            entered_tx.send(()).unwrap();
            release_rx.await.map_err(|e| e.to_string())?;
            fs::write(&origin, b"download A").map_err(|e| e.to_string())
        },
    );
    let change = async {
        entered_rx.await.unwrap();
        let wait = coordinator.begin_transition();
        tokio::pin!(wait);
        tokio::select! { biased; _ = &mut wait => panic!("transition passed an in-flight effect"), _ = tokio::task::yield_now() => {} }
        assert!(!coordinator.is_owner(&first));
        release_tx.send(()).unwrap();
        let guard = wait.await.unwrap();
        *current.lock().unwrap() = next;
        drop(guard);
    };
    let (effect_result, _) = tokio::join!(effect, change);
    assert!(effect_result.unwrap_err().contains("SyncStale"));
    assert_eq!(fs::read(&origin).unwrap(), b"download A");
    assert!(!other.exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn f3_concurrency_download_arriving_after_switch_cannot_commit() {
    let coordinator = SyncCoordinator::default();
    let first = request("ws_001", 1);
    let next = request("ws_002", 2);
    let current = Arc::new(Mutex::new(first.clone()));
    let permit = active(&coordinator, first);
    let root = temp_root();
    let origin = root.join("ws_001/note.md");
    let other = root.join("ws_002/note.md");
    fs::create_dir_all(origin.parent().unwrap()).unwrap();
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (bytes_tx, bytes_rx) = oneshot::channel::<Vec<u8>>();
    let download = async {
        started_tx.send(()).unwrap();
        bytes_rx.await.unwrap()
    };
    let change = async {
        started_rx.await.unwrap();
        let transition = coordinator.begin_transition().await.unwrap();
        *current.lock().unwrap() = next;
        drop(transition);
        bytes_tx.send(b"late download".to_vec()).unwrap();
    };
    let (bytes, _) = tokio::join!(download, change);
    let result = permit
        .effect(
            || Ok(current.lock().unwrap().clone()),
            || async { fs::write(&origin, bytes).map_err(|e| e.to_string()) },
        )
        .await;
    assert!(result.unwrap_err().contains("SyncStale"));
    assert!(!origin.exists());
    assert!(!other.exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn f3_concurrency_upload_error_cancel_and_retry_keep_owner_and_effects_scoped() {
    let coordinator = SyncCoordinator::default();
    let first = request("ws_001", 1);
    let next = request("ws_002", 2);
    let current = Arc::new(Mutex::new(first.clone()));
    let recorded = Arc::new(Mutex::new(Vec::<String>::new()));
    let permit = active(&coordinator, first.clone());
    let (entered_tx, entered_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let effects = recorded.clone();
    let operation = permit.effect(
        || Ok(current.lock().unwrap().clone()),
        || async {
            entered_tx.send(()).unwrap();
            release_rx.await.map_err(|e| e.to_string())?;
            effects.lock().unwrap().push("ws_001".into());
            Ok(())
        },
    );
    let change = async {
        entered_rx.await.unwrap();
        let wait = coordinator.begin_transition();
        tokio::pin!(wait);
        tokio::select! { biased; _ = &mut wait => panic!("transition passed an upload"), _ = tokio::task::yield_now() => {} }
        release_tx.send(()).unwrap();
        let guard = wait.await.unwrap();
        *current.lock().unwrap() = next.clone();
        drop(guard);
    };
    let (result, _) = tokio::join!(operation, change);
    assert!(result.unwrap_err().contains("SyncStale"));
    drop(permit);
    let retry = active(&coordinator, next.clone());
    let effects = recorded.clone();
    let failed = retry
        .effect(
            || Ok(current.lock().unwrap().clone()),
            || async { Err::<(), String>("network error".into()) },
        )
        .await;
    assert_eq!(failed.unwrap_err(), "network error");
    retry
        .effect(
            || Ok(current.lock().unwrap().clone()),
            || async {
                effects.lock().unwrap().push("ws_002".into());
                Ok(())
            },
        )
        .await
        .unwrap();
    assert_eq!(*recorded.lock().unwrap(), vec!["ws_001", "ws_002"]);
}
