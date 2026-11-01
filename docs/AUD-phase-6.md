# Phase 6: coverage, listing, logout, OAuth storage

## Current status

AUD-009, AUD-011, AUD-013, and AUD-014 have implementation changes. The approved policy for unavailable or locked Linux Secret Service is fail closed: no new Google Drive connection, no plaintext fallback, no automatic memory-only session. Existing JSON files remain untouched after a failed migration and are retried when the secure store becomes available. All automated tests use fictional credentials and isolated temporary files.

## AUD-009 coverage matrix

| Area | Risk | Existing coverage | Added in this phase | Remaining |
| --- | --- | --- | --- | --- |
| Local note integrity and recovery | Lost or cross-written content | Atomic save, recovery, editor coordinator tests | None | Manual Windows filesystem behavior |
| Drive/account isolation | Wrong-account transfer or deletion | Provenance, tombstone, mock HTTP, epoch tests | Logout clears credentials before HTTP response | Live two-account Drive test with fictional notes |
| Archive projection | Incorrect causal state | Archive merge and account tests | None | Live cross-device exercise |
| Listing | Missing, internal, or stale notes | StrictMode initialization tests | 1,000-note native scan, Unicode, internal-file exclusion, rename/delete, read error | Tauri/WebView render and IPC timing on target platforms |
| Logout UI | Accidental disconnect and duplicate request | Backend remote-revocation tests | Confirmation controller cancellation, duplicate, error and retry | Interactive modal and active-sync exercise |
| OAuth credential store | Plaintext refresh token | Legacy migration tests | Mocked initial save, restore, migration, interruption/retry, locked or failed store, two accounts, stale renewal, logout | Native Windows Credential Manager and Linux Secret Service runtime checks |

## AUD-011 implementation and measurement

The old Tauri path called `readDir` and then `stat` once per note, causing N+1 filesystem IPC requests. `list_note_files_with_stats` scans a fixed `Documents/lyra` directory in a blocking worker, returns names and timestamps in one IPC response, and rejects paths that resolve outside Documents. It ignores hidden files, unsupported extensions, directories, and symlinks. The Node test fallback keeps the prior reader. There is no cache; every list initialization scans the current directory, so save, rename, delete, archive, and Drive refresh invalidation remain unchanged.

Run `node scripts/bench-listing.mjs` to recreate the synthetic test. The script uses an isolated temporary directory, five repetitions per size, and reports medians. It compares the previous asynchronous per-file metadata traversal with a batched synchronous traversal equivalent to the new native algorithm. This is a **filesystem algorithm comparison**, not an end-to-end Tauri IPC or WebView benchmark. CPU/runtime differences between Node and Rust are not represented. Measured results from this workstation, in milliseconds:

| Notes | Previous total | Batched total | Previous after one-note change | Batched after one-note change |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 1.09 | 0.55 | 1.16 | 0.67 |
| 1,000 | 8.85 | 4.51 | 7.59 | 3.96 |
| 5,000 | 57.01 | 24.83 | 54.02 | 24.45 |
| 10,000 | 109.10 | 49.68 | 108.72 | 42.00 |

At 10,000 notes the measured Node heap was 111.25 MiB during the two-algorithm benchmark. Store update and rendering in the actual app were not directly measured. React still creates one `ItemFile` per visible note; this is the main remaining large-list risk. The native command reduces the IPC count from N+1 to one per refresh. Actual IPC time and Windows performance require manual measurement.

## AUD-013 behavior

Preferences now opens the existing confirmation modal before requesting logout. It states that local notes remain available and that pending changes may sync on reconnect. Active sync and pending authorization receive specific warnings. Cancellation does not call Rust. Duplicate confirmation is suppressed while the first request runs; failure leaves the dialog open for retry. Rust removes local auth state and advances the account epoch while holding the manifest lock, then revokes remotely without holding that lock. Remote revocation failure remains nonfatal after local disconnect.

## AUD-014 secure credential storage

`keyring` uses Windows Credential Manager and Linux Secret Service through explicit `windows-native` and `sync-secret-service` features. Other platforms fail closed. The complete active `StoredAuthState` is stored as a versioned **binary** payload in one native credential entry. There is no token-bearing JSON write path. Existing `gdrive_oauth.json` is a configuration route for the OAuth desktop *client* ID/secret, not a user access or refresh token. Desktop OAuth clients cannot keep their client secret confidential from the device owner. Fedora builds need `dbus-devel`; the project build instructions include it.

All application credential operations use one process mutex. A new OAuth flow probes native-store write, readback, and delete before opening the browser. Login persists only if the account epoch is unchanged and no other active credential exists. Token renewal requires the same epoch, Google `sub`, and original refresh token; it preserves a newer auto-sync preference. Logout advances the epoch and deletes the native entry before remote HTTP revocation. A failed remote revocation does not restore the local session. If a damaged credential cannot be read, logout still removes it but reports that remote revocation was not confirmed. Native-store calls are synchronous and may block the calling backend thread while the desktop secret service responds.

Migration reads only the two known old paths: app-config `gdrive_token.json` and Documents `lyra/.gdrive_token.json`. It rejects corrupt or conflicting old credentials. It writes the binary secure payload, reads it back, compares the complete state, and only then removes both known JSON copies. If write or readback fails, both old files remain unchanged. If cleanup is interrupted, a subsequent load compares the native credential with any remaining JSON and retries cleanup. A native credential that conflicts with an old JSON blocks automatic activation rather than silently replacing an account. Explicit logout removes known JSON copies without migrating them first. Physical erasure of previously written bytes is not guaranteed on journaling or snapshot-capable filesystems.

No token value is returned to React. OAuth and revocation HTTP failures return status or sanitized errors without response bodies; `OAuthTokens` debug output redacts both tokens. The native-store implementation maps platform failures to a fixed message asking the user to enable or unlock the store.

The Drive token provider now keeps a short-lived access-token lease scoped to its account and session epoch. Concurrent HTTP requests share one cache-miss lock, so a valid token is not repeatedly fetched from Secret Service for every request. A cache miss checks the verified Google `sub` and epoch against the provider binding; 401 refresh still uses the global refresh mutex and persists the new token in the native store. Logout advances the epoch, clears registered in-memory token leases, and makes old providers unusable. OAuth preflight still probes write/read/delete before browser launch, and login still writes and reads back the actual credential. Those are necessary secure-store operations and may still cause operating-system unlock prompts. The exact reason for the two prompts reported on Fedora requires a live Secret Service trace; automated tests use mocks and do not assert that the prompts disappear.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml -- --quiet`: 152/152 passed.
- `node --experimental-strip-types --test tests/*.test.ts`: 101/101 passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `pnpm run build`: passed; existing Vite archive chunk warning remains.

No test touched the user's notes, actual OAuth credentials, Google Drive, or an updater installation. The interactive logout dialog, Tauri IPC throughput, and native keyring behavior on Fedora/Windows 11 remain to be checked manually. A Windows cross-check from this Fedora host could not complete because the MSVC `lib.exe` tool is absent; it did not reach Lyra's source compilation. AUD-001, AUD-002, AUD-003, AUD-004, AUD-005, AUD-010, and Phase 5 regression tests were included in the Rust/TypeScript suites; cross-platform and live-service behavior was not verified here. A successful migration removes the known JSON directory entries, but not necessarily forensic remnants in journals, backups, or snapshots.
