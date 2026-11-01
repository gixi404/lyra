# F4 Google Drive workspaces: implementation in progress

F4 is not complete. The production sync gate remains closed in Rust. Creating
and linking a Drive workspace does not start remote synchronization.

## Account binding now present

- A workspace can be created with kind `google_drive`. It remains read-only
  until a verified Google `sub` is bound through OAuth.
- Credentials are stored under a workspace-specific keyring entry. The old
  global entry and plaintext JSON files are not automatically attached to a
  workspace. Existing plaintext JSON is still migrated to the inert global
  secure entry with readback verification before removal, preserving the
  previous credential migration guarantee.
- The registry rejects duplicate Google subjects. Binding also checks every
  surviving Drive workspace marker, including after registry reconstruction.
- `.lyra_drive_binding.json` records the verified subject and a random, stable
  nonce for future remote-folder identity. It contains no OAuth tokens. A
  reconstructed workspace accepts reconnection only with its original `sub`.
- The Drive client searches by this nonce in `appProperties`. A new folder
  receives a pre-generated Drive ID that is persisted before POST. A retry
  uses that same ID and verifies the object after a 409. Older dispatched
  intents without an ID remain blocked if their result is ambiguous. Search
  and create are separate calls with F3 checkpoints.
  Ambiguous results, missing IDs and changed folder IDs stop synchronization.
  The new content runner uses this path; the production command still stops at
  `SyncPaused` before invoking the runner.
- Login checks the captured workspace and epoch after OAuth. A workspace
  switch during the browser flow rejects the late result.
- The new `.lyra_workspace_drive_manifest.json` requires the workspace ID,
  verified `sub` and folder nonce. It never imports an old account manifest.
  Each write compares a revision under F3's critical section and
  `MANIFEST_LOCK`; a changed manifest causes a retry error. A corrupt primary
  blocks synchronization even when a valid backup exists: the backup may
  predate a tombstone, so recovery requires an explicit decision. Unsafe note
  names and duplicate remote deletion targets are rejected.
- Local deletion in a bound Drive workspace writes to this manifest. It only
  records a remote tombstone for the exact local note identity and remote ID.
  The remote deletion primitive confirms the target in the bound folder and
  holds a local deletion lease. If the target is active it now stops before
  PATCH, because Drive might move it after listing. The tombstone remains.
  The new content runner calls this primitive after resolving the folder;
  the production gate still prevents remote access.
- Workspace archive projection uses manifest note IDs instead of per-note
  consent. The archive account key must match the workspace's verified `sub`.
  An immutable content version retains the original remote ID as its archive
  anchor, preserving causal archive operations across version changes. Reads
  and ledger writes run through F3 effects. Publishing new operation files is
  paused until their creation is idempotent.
- Logout cancels and drains an active F3 effect before removing credentials.
- The per-note consent dialog and management action are no longer presented.
  The old authorization IPC mutations reject requests.
- Creating a note inside a Drive workspace no longer records a per-note upload
  grant. A disconnected Drive workspace projects only local archive choices;
  it does not reuse the ledger's last account. Local note renames retain the
  stable note ID and record a pending remote rename. After a crash between the
  local rename and manifest write, the content runner can reconcile the name
  from the note ID. Unexpected remote renames stop the run.

## Content runner and cancellation

`workspace_sync::content::ContentSession` is compiled into production and is
called by the `gdrive_sync_now` path **after** the still-closed `sync_gate`.
Each effect re-resolves the active workspace, epoch, verified account and
binding marker. Its HTTP client is bound to the captured account key and auth
epoch. F3's critical section spans each HTTP call or local commit, and
`EFFECT_LOCK` serializes remote content effects with local deletion and rename.
`MANIFEST_LOCK` is never held over HTTP. The old engine is test-only.

| Effect | Checkpoint and local coordination | Cancellation or interruption |
| --- | --- | --- |
| Folder search/create and listing | F3 effect; planned Drive ID and dispatch flag persisted before POST; nonce and folder ID confirmed in scoped manifest | A late response is discarded. A retry uses the same ID and verifies a 409 by ID. Legacy intents without a planned ID block ambiguous retries. |
| New upload | Durable `Prepared` intent with planned Drive ID, then `Dispatched` before POST; local identity checked under manifest and file locks; response confirms parent, nonce, note ID and MD5 | No manifest commit after cancellation or failed HTTP. Retry uses the same ID; a 409 requires a matching GET by ID. |
| Existing upload | Publishes an immutable file with a new planned ID and `lyra_previous_id`; the prior remote ID and digest remain in manifest history | No PATCH is sent. A changed historical file is imported as a separate conflict copy on a later run. |
| Unique remote successor | Requires matching predecessor ID, note ID, workspace nonce, folder and unchanged local baseline before atomic local replacement | Multiple successors or local edits are preserved as separate conflict copies. The prior ID and causal archive anchor remain in the manifest. |
| New download | F3 effect around GET; durable target and planned note ID before exclusive, synced local create under manifest and file locks | Late bytes are discarded. Retry adopts only the exact planned note ID and bytes; an ambiguous target blocks without replacing or duplicating it. |
| Mapped download and conflict | F3 effect, MD5 check, file lock and local snapshot comparison; atomic replace only when the local note has not diverged | Concurrent local and remote edits preserve both originals; a separate conflict copy is created for divergent historical versions. Missing mapped notes still block. |
| Rename | Local note ID and manifest checked under locks; an active remote rename stops before PATCH | Pending intent survives; a remote rename already visible with the same ID may be reconciled without issuing a PATCH. |
| Trash | Tombstone, retired note ID and bound-folder membership checked with a local lease; an active target stops before PATCH | Tombstone remains; an already trashed or missing target can be reconciled after verification. |
| Archive operations and result events | Archive reads and ledger writes use F3 effect; unpublished operation files stop before POST until they have durable create identities | Local immutable operations remain unpublished and recoverable; a cancelled owner cannot publish a result into a later workspace. |

## Persistent-effect audit

| Path | Current state | Requirement before enabling |
| --- | --- | --- |
| `gdrive_sync_now` | Releases `MANIFEST_LOCK` before HTTP, then retains a F3 permit for the new runner; `SyncPaused` still blocks entry | Prove all operations below before opening the gate. |
| Legacy `run_sync_with_client_and_emitter_with_id` | Test-only; still contains unsafe global behavior for historical regression tests | Never call it in production. |
| Folder and manifest | Nonce search, pre-generated ID, durable dispatch flag and strict workspace manifest | Validate API behavior with controlled test accounts before enabling. |
| Local deletion and remote trash | Scoped tombstone; active remote trash explicitly blocked before PATCH | Resolve the external Drive move race before enabling remote deletion. |
| Local and remote rename | Pending intents and note-ID recovery; active remote rename explicitly blocked before PATCH | Resolve the external move race before enabling remote rename. |
| Existing content update | New versions use immutable creates; old IDs remain in history and divergent historical content becomes a conflict copy | Complete visible conflict resolution and controlled Drive validation before enabling. |
| Events and status | New runner emits scoped start, finish and error events; frontend filters by workspace/epoch | Add deterministic late-event tests against the production command. |

## Still required before enabling sync

The old engine remains compiled only for tests. Active remote content updates,
renames and trash are blocked before PATCH: Drive v3's documented `files.update`
contract does not establish the conditional precondition this client would
need. The resource `version` is output-only and a prior `modifiedTime` or MD5
read does not close the race. No real Drive experiment has been performed.
The documented `files.generateIds` mechanism supports idempotent creates and
409 responses on repeated creates. New folder, note and version uploads use
that ID and a durable intent. The runner verifies a matching remote object
before committing after an ambiguous response. Old intents without a planned
ID remain blocked. Conflict records persist in the workspace manifest and
appear in sync results. The user can keep both versions by renaming a conflict
copy locally; that explicit action clears its conflict notice while retaining
both local and remote content. A dedicated conflict review interface is still
missing. Scoped archive publication also stops before POST until it has an
idempotent create protocol. Production late-event behavior and real Drive
compatibility need controlled validation before opening the global gate.

Official API references: [files.update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update),
[File.version](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
[pre-generated IDs and upload retries](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

The existing account-scoped legacy manifests and provenance ledgers are not
treated as authorization for new Drive workspaces. No real Drive operations
were executed for this stage.
