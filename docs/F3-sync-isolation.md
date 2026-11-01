# F3 workspace sync isolation

F3 introduces `SyncRequest { workspace_id, epoch }`. The backend snapshot exposes the registry epoch. Every manual sync request and status read sends the captured pair to Rust. Rust validates it against the active registry entry and derives the notes directory from the validated ID. A local workspace returns `SyncDisabled`. A Drive workspace returns `SyncPaused` until F4; neither path runs remote HTTP.

`SyncCoordinator` owns at most one active request and one trailing request. A trailing request is promoted only when its workspace and epoch still match the current context. Workspace management first marks the owner cancelled, clears the queue and waits for any critical effect before changing the registry. An effect checks `still_valid()` after entering the shared critical section and again after the effect. This prevents a check/write race with workspace selection without holding `MANIFEST_LOCK` across remote HTTP. The F3 tests use mock download, upload and manifest operations with deterministic synchronization; no real Drive account is accessed.

The frontend stores the epoch with the active notes directory. Sync events without matching `workspace_id` and `epoch` are ignored, including legacy unscoped events. Late status and command responses, delayed timers and archive refresh notifications are also checked before changing visible state. Workspace changes clear the former sync UI state. No synchronization event is emitted by the paused F3 backend.

Pending authorization, local-note management and internal welcome checks also carry the captured request. Rust validates it under `MANIFEST_LOCK` before reading or changing provenance. A delayed welcome autoarchive checks its origin directory after each await and cannot archive a same-name note in the newly selected workspace.

The old Drive orchestration is excluded from production builds. Its legacy entrypoint returns `SyncPaused` unconditionally, even if the F1 pause flag changes. F4 must connect a verified account and workspace-scoped manifest to a `SyncPermit`, add checkpoints around each actual remote and local effect, and then emit context-bearing progress/results. F3 does not enable content sync, OAuth per workspace, or remote migration.

Manual checks remain necessary on Fedora and Windows 11. Use fictional notes and accounts only when F4 enables real sync; for F3, verify that local spaces report disabled sync, Drive remains paused, and changing spaces clears old sync errors or progress.
