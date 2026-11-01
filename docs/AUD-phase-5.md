# Phase 5 concurrency and lifecycle safeguards

## AUD-006: manifest and remote deletion

`gdrive_delete_file` persists a tombstone tied to the verified account, retired note ID, and exact Drive file ID before removing the local note. The manifest lock covers that local transaction. The immediate remote trash operation rechecks the persisted tombstone, releases the lock for HTTP, then reacquires it and removes only the same tombstone. The Drive client remains bound to the account and authentication epoch captured before HTTP. An HTTP error leaves the tombstone for a later sync. If the remote trash succeeded but the final local manifest write fails, the tombstone remains and the next sync can resolve the already trashed remote ID.

The final sync save compares its initial manifest with the current on-disk manifest. It retains concurrent changes to file mappings, tombstones, and folder ID, and never revives a mapping removed while HTTP was in progress. Local note content and archive metadata are outside this transaction.

## AUD-007: editor sessions

Every explicit file selection increments a generation. The editor component is keyed by that generation and filename, creating a fresh coordinator and content state for each selection. An older coordinator keeps its own filename, queued saves, and draft; it cannot be retargeted through `updateOptions` or `setCleanContent`. Unmount waits for its real save queue. Async file loading checks whether its component is still active before applying results. A new edit made during conflict rescue remains dirty instead of being replaced by the remote version, and the draft is flushed before conflict handling.

Before the file store applies a new selection, it synchronously flushes drafts for mounted editor sessions. This keeps a rapid A to B to A transition from missing A's newest draft while its disk save is still pending.

Draft keys remain filename based for compatibility with existing recovery data. Renames move those keys. This is not equivalent to a stable note ID; an old draft for a deleted and recreated name is handled by the existing reconciliation path and should be checked manually when validating recovery scenarios.

## AUD-008: initialization

List loading applies results only while its effect remains active. The recovery notifier registers before draining the Rust queue, shares concurrent initialization, removes partial listeners on failure, and can retry on focus. Global Drive listeners complete registration before a sync or login begins; partial registration is cleaned up and retried. Component-bound listeners still unlisten on cleanup.

## AUD-012: update restart

All update restart actions use `restartInstalledUpdate`. It waits for registered editor sessions, including saves finishing after unmount, and for the legacy preferences write. It checks the editors again before `relaunch` so a new edit during preparation blocks or is saved. Failed detached saves block restart until a later successful save of that note, and a timeout also blocks restart. No update is installed by automated tests.

The final audit found that `downloadAndInstall` exits the process during installation on Windows, before the guarded `relaunch` path runs. The update flow now downloads first, confirms editor saves and preference persistence, and only then calls `install`. Editing is read-only while installation is in progress. The existing guarded `relaunch` remains in use after installation on Linux. An operating-system forced shutdown or an external process terminating Lyra remains outside this guard. Windows 11 and real Google Drive behavior still require manual validation with fictitious notes before stable distribution.
