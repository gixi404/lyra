# Final audit remediation

The final audit identified seven follow-up findings. The focused correction round addresses the Windows update exit path, the notes directory symlink, manifest writes outside the mutex, process-local concurrency, early sync errors, the release test gate, and unsupported macOS publication.

## Data and update boundaries

- The updater downloads first. Before installation, it waits for editor saves to finish in Rust and for preferences to persist. A failed or timed-out save prevents installation. The editor is read-only while the installer runs. On Windows, the updater plugin may exit the process during `install`, so all preparation must occur before that call.
- Rust note operations and synchronization reject a symbolic link at the `Documents/lyra` directory itself. File name and target symlink checks still apply. External programs can replace paths between checks; they do not participate in Lyra's in-process locks.
- The post-sync `last_error` update reads and writes the manifest under `MANIFEST_LOCK`. An early return from synchronization releases `IS_SYNCING` through a guard.
- The single-instance plugin is registered first. A second launch in the same desktop session focuses the existing main window and exits before performing app setup. Linux instances in separate D-Bus sessions and external editors remain outside these process-local locks.

## Release boundary

The GitHub release workflow runs Rust tests, `cargo check`, TypeScript tests, and the frontend build before Tauri packaging. It builds Windows and Linux; macOS is not offered because the current credential store deliberately rejects that platform. The TypeScript test command requires Node 22 in CI.

## Validation still required

Automated tests use isolated directories and mock saves. Before a stable release, use fictitious notes to check Windows 11 installation with pending and failing saves, second-launch window focus on Windows and Fedora, symlink and junction behavior, native Windows Credential Manager and Linux Secret Service, and synchronization with two test Google accounts. No automated test installs an update or accesses a real account.
