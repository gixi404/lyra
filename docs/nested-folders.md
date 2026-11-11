# Nested local folders

Lyra displays the Documents/lyra directory as a virtual root named Lyra. The root is always visible and is the default destination for new notes. It has no additional physical directory and cannot be renamed, moved, or archived. A physical child directory named `Lyra` is a separate user folder.

User folders are real directories beneath the root. The Rust listing returns note paths, folder paths (including empty folders), file statistics, and listing warnings. The React tree groups direct notes under the virtual root, renders nested folders recursively, persists expansion and per-parent folder order in local preferences, and applies the existing sort choice only to notes. Order changes never rename directories.

Folder archives are logical. `.lyra_folder_state.json` records archived paths, and a backup preserves the last valid state. Archiving hides a subtree without moving its files; recovery restores the original path. Creation and moves into archived subtrees are blocked until recovery. External filesystem changes are reconciled when the list regains focus and every 60 seconds while visible.

Folder actions reuse the file menus and popups so both are visually indistinguishable: the folder context menu is rendered by the shared `ContextMenu` component, and creating, renaming, archiving and recovering a folder use the shared dialogs. Archiving a folder requires an explicit confirmation that states that its subfolders and notes are archived as well. The shared menu rules are described in `AGENTS.md`.

Physical note and folder moves share the frontend path operation flow. It flushes open editors and drafts, prepares draft copies at destination identities, invokes a Rust move under the manifest lock, then migrates local preferences and selection. Rust rejects unsafe paths, symbolic links, collisions, cycles, stale folder inventories, and moves of notes bound to Google Drive. `.lyra_folder_move.json` records an interrupted move; the next listing or move recovers an unambiguous state and refuses ambiguous states for manual recovery. Atomic autosave rejects a note that no longer exists at its old path so a delayed save cannot recreate it.

Google Drive folder synchronization is outside this implementation. Existing Drive synchronization remains root-note based. Nested local notes are not promised to sync. Local moves of notes with Drive bindings are rejected; broader folder support requires a separate design for remote identity, deletion, conflicts, and account-scoped recovery.

Before release, exercise folder creation, recursive expansion, note creation, drag reordering, physical moves with an open editor, archived subtree recovery, and external changes using disposable test notes in the packaged desktop application on each supported platform.
