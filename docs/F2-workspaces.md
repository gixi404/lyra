# F2 workspace management

F2 adds local workspace creation, renaming, selection and safe removal. Rust owns `workspaces.json`, enforces a maximum of five registered workspaces, validates names and IDs, and keeps IDs monotonic. The selector shows registered spaces; a missing or damaged directory cannot be selected.

Switching waits for the editor's confirmed atomic saves and preference persistence. A failed or timed-out save leaves the original workspace active. The editor and list are cleared before the new workspace is rendered. Note mutations carry the expected workspace ID, which Rust checks under `MANIFEST_LOCK` before resolving the note path. Late operations from the previous editor are rejected.

Browser draft, scroll, modified-date and welcome state use workspace-scoped keys. The workspace named by the F1 migration journal can still read its old unscoped keys. Archive projections are loaded from the selected workspace before mounting the note UI; a late projection from another workspace is ignored. Global display preferences remain shared.

Deletion requires another active workspace. Rust moves the entire inactive directory to `lyra/rescatados/espacio-<id>-<random>/<id>/`; it never deletes note bytes. A deletion journal in app config lets startup finish a move interrupted between the directory rename and registry save. The UI blocks deletion when browser drafts for that workspace remain. The last workspace cannot be deleted.

Google Drive content sync remains paused in Rust. F2 does not connect workspaces to Drive or implement F3. Manual checks are required in Fedora and Windows 11 using fictional notes: create five spaces, switch with a pending or failed save, same-name notes and drafts, archive state, delete and restart after a simulated interruption. Windows 11 validation remains a release prerequisite.
