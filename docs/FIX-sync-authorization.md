# Sync, local-note consent, welcome identity, and credential-store follow-up

## Diagnosis and behavior

| ID | Finding | Change |
| --- | --- | --- |
| FIX-001 | The frontend created the welcome file without a Rust provenance marker. Sync built the consent request before its name/content upload check. | Rust now exclusively creates the canonical welcome file and records an internal marker on its logical note ID. Only a verified marker with matching original bytes is excluded. |
| FIX-002 | OAuth preflight performs secure-store write/read/delete, login performs another read/write/readback, and the old HTTP provider reread the store for each request and account check. The source of the two observed Fedora dialogs is not proven without a native trace. | A provider uses a short-lived account/epoch-bound token lease and serializes concurrent cache misses. Secure-store preflight, migration, readback, and refresh persistence remain mandatory. |
| FIX-003 | The backend starts initial sync in a task, while the frontend showed its loading toast only for a manual `syncNow` call. | The backend emits sync start and correlated finish/error events. The frontend shows `Sincronizando...` only for a live initial connection or note authorization request, closes it on completion/error/logout, and ignores stale request IDs. Background sync continues without a loading toast. |
| FIX-004 | The IPC command approved every note in a pending request, and the view sent only names. | The view sends note IDs and names. The UI selects none by default. Rust validates a unique selected subset, account, request ID, epoch, identity, metadata, and content. |
| FIX-005 | Local sync enumeration used `flatten()` and could silently skip unreadable entries and files. Other legitimate reasons for a missing prompt include an existing binding, valid legacy manifest evidence, or a Rust-created note bound to the active account. | Enumeration/read errors now stop the cycle conservatively. The explicit management view rescans local notes and reports authorized, pending, declined, and internal states. The exact third note from the manual report cannot be classified without its historical ledger and manifest state. |

## Sync progress notifications

The sync-start event carries a reason (`background`, `initial_connection`, or `authorization`) and an optional request ID. The login and authorization flows register their request IDs before the backend can emit the start event. A queued backend sync retains the visible request context for its trailing run. The frontend shows loading progress only when a visible reason matches a live request; logout clears those requests. Background sync still updates internal status and reports errors.

## Welcome transition and migration


The marker is an optional field in each provenance record, so old ledgers remain readable. Rust checks the canonical content digest at creation and writes the file with exclusive creation before marking it. If ledger persistence fails, the file remains local but has no internal marker, so it cannot silently bypass consent. Saving the same bytes preserves the marker. A successful changed save clears it; if the ledger update fails, the next scan detects the byte mismatch and creates a pending ordinary identity. An external modification also retires the old identity on scan. Rename carries the logical identity; deletion and recreation do not. Older same-named files are never inferred to be internal from filename or approximate content. The frontend autoarchive path consults Rust's verified marker.

## Consent and note classification

Partial consent writes only selected account bindings. The unselected note IDs are stored in a per-account declined set. A new note can prompt without reopening previously declined notes. Cancel stores a decline for the current request; the user can later choose **Manage local notes** in Google Drive preferences to rescan and reopen these notes through the same Rust authorization command. A changed, deleted, replaced, or stale note invalidates the request. A missing or unreadable note blocks authorization; no name-only fallback exists. The source directory and local notes remain unchanged by the management command except for the provenance ledger's classification state.

The five states requested for every local note are represented as: authorized, pending, declined, internal, or blocked by an explicit scan error. Unsupported extensions are outside Lyra's note set. The manager reports the verified destination account. A backend-created note under the connected account remains automatically linked under the existing AUD-001 rule; a copied or externally created note does not.

## Manual validation still required

- Fedora: use fictitious notes and a locked/unlocked Secret Service to correlate each native unlock dialog with preflight, actual credential save, and first HTTP token read. The code change reduces redundant reads but does not prove the desktop prompt count.
- Fedora and Windows 11: confirm initial, automatic, manual, fast, failed, cancelled, and account-switch sync toasts and the individual consent dialog in the real WebView.
- Two test Google accounts: verify that an internal welcome remains local; an edited welcome requests consent; a partial selection uploads only the chosen notes; and declined notes can be authorized later. Do not use real notes or credentials for automated tests.
