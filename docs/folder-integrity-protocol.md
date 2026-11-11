# Local folder integrity protocol (design constraints)

This document describes the required invariants for the local nested-folder implementation. It does not change note bytes or require a bulk migration.

1. A Lyra logical identity is independent of a path. A filesystem identifier is evidence about an open object, not the logical identity and not proof of its history after the handle closes. Physical identifiers may be reused.
2. A save is successful only if the expected logical identity is still bound to the file displaced by the atomic replacement. Any ambiguous replacement must retain both the previous file and the pending draft and report failure.
3. A move has one durable operation ID and phases: prepared, physical move observed, provenance and disk drafts reconciled, frontend acknowledgement, complete. Replaying any phase must leave the same bytes and identities. A command error after preparation is never interpreted as proof that the move did not happen.
4. An old M9 draft is retained until the new draft has been read back and compared. Conflicting versions remain available for explicit resolution. A reused path must not inherit a draft solely because its name matches.
5. A corrupt primary metadata file may be restored from a valid backup. If neither copy is valid, operations depending on it stop; data files remain untouched. Metadata is versioned, written atomically, and excluded from the explorer and user statistics.
6. External rename, move, replacement, and path reuse are ambiguity, not implicit permission to rebind identity. Unsafe volumes and unsupported operations fail closed, while independent operations continue.

## Platform evidence and limits

On Windows, `GetFileInformationByHandleEx(FileIdInfo)` exposes a volume serial and 128-bit file ID for open-handle comparison. Microsoft documents that file IDs are filesystem-specific and can be reused over time. `ReplaceFileW` can retain the displaced file under a backup name; its failure outcomes can also leave the two files at different names. Therefore a pathname check followed by an ordinary replace is insufficient. Windows functional validation requires an installed application on real target filesystems; cross-compilation alone does not establish it.

On Linux, device/inode comparison is valid for concurrently open handles. A persistent logical binding needs separate metadata and a retained reference to prevent inode reuse. Atomic rename alone has no compare-and-replace precondition, so the displaced file must be preserved and verified before acknowledging a save.
