# AUD-010 archive state synchronization

Lyra stores note contents in `~/Documents/lyra/`. Archive state is a separate, local-first operation log. No archive metadata is inserted into `.txt` or `.md` files.

## Storage and identity

`~/Documents/lyra/.lyra_archive_state.json` is the authoritative local archive ledger. It is written through a temporary file and keeps a valid `.bak` copy. It contains a device ID, a revision, local-only states indexed by the provenance note ID, and per-account operation maps. `.preferences.json` and localStorage `paper` remain a UI projection for compatibility; they are rebuilt from the ledger at startup and after sync.

Each remote operation is an immutable `op-<operation_id>.json` file in `.lyra_archive`, a child folder of the active account's Lyra Drive folder. It has `schema_version`, `operation_id`, `account_key`, `remote_note_id`, `device_id`, `archived`, and `parents`. The remote note ID is the account-bound Google Drive file ID from the AUD-001 provenance ledger. Local note IDs and filenames are never sent in these operations. The folder uses the existing `drive.file` OAuth scope.

Only notes with a current authorized binding and Drive ID for the verified account can publish archive operations. Local notes without that binding keep their archive state locally. A note linked to multiple accounts has separate operation histories; an ambiguous legacy preference is kept local and is not published to either account without a subsequent explicit archive action in that account.

## Resolution

An operation lists the operations its device had observed for that note when the action was made. The current state is computed from maximal operations. A causal successor supersedes its parents, so an unarchive after observing an archive wins. If maximal operations disagree, they are concurrent: archive wins while both remain in the log. A later action that observes both maxima can choose either state. Download order and wall clocks do not affect the result. Only a concurrent, contradictory set of maxima is reported as a conflict.

The sync stage runs after note content and provenance have been persisted, so newly uploaded or downloaded notes have Drive IDs. It reads and validates remote operations before writing local pending operations. Each upload creates a separate file; no shared metadata file is overwritten. An upload error leaves the operation unpublished locally for a later retry. A repeated download recognizes an existing operation ID and does not create another local operation.

## Legacy migration and safety

On the first startup with this ledger, existing archived names from `.preferences.json` are matched only to current local note identities. Missing names are not assigned to a later file with the same name. Migration is idempotent. A legacy archived state is published as an initial operation only after remote history has been read and found empty for that note. Existing remote history takes precedence over a stale legacy projection. Content sync failure does not erase pending archive actions.

Remote metadata with a wrong account, unsupported version, invalid operation ID, missing causal parent, cross-note parent, or cycle is rejected. This stops archive reconciliation for that cycle without altering note content. Account identity comes from Rust's verified OAuth state, not from React. The existing AUD-001 upload and deletion authorization rules remain in force.

## Validation and remaining limits

Automated tests cover local persistence, causal unarchive, concurrent archive priority, later resolution, download order, migration, name reuse, account isolation, invalid metadata, and two-device exchange through a simulated Drive HTTP server. Manual validation on Windows 11 and two test Google accounts remains necessary before stable distribution. Remote operation files are ordinary Drive files: a user who manually deletes or changes them outside Lyra can damage the archive history. The local ledger and its backup preserve the device's last known operations, but cannot reconstruct a deleted remote history on a new device.
