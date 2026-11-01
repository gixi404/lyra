/**
 * Directory that currently holds the notes, relative to `~/Documents`.
 *
 * F1 moves the notes from the legacy root (`lyra/`) into the active workspace
 * (`lyra/workspaces/<id>/`). Everything that reads or writes notes resolves the
 * path through this module instead of hardcoding `lyra`, so a single place
 * controls where the app looks after the migration.
 *
 * Only a directory shaped like a workspace id is accepted. Anything else
 * (absolute paths, other roots, traversal) is rejected. Until a valid backend
 * workspace is known, note operations fail closed.
 */

import { join } from "@tauri-apps/api/path";

const WORKSPACE_DIR_PATTERN = /^lyra\/workspaces\/ws_\d{3,}$/;

let notesDir: string | null = null;
let legacyWorkspaceId: string | null = null;
let workspaceEpoch: number | null = null;

/** Read the current directory without granting access when none is active. */
export function currentNotesDir(): string | null {
  return notesDir;
}

export function currentWorkspaceId(): string | null {
  return notesDir?.split("/").at(-1) ?? null;
}

export function currentSyncRequest(): { workspaceId: string; epoch: number } | null {
  const workspaceId = currentWorkspaceId();
  return workspaceId && workspaceEpoch !== null ? { workspaceId, epoch: workspaceEpoch } : null;
}

export function setWorkspaceEpoch(epoch: number | null): void {
  workspaceEpoch = typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

export function currentLegacyWorkspaceId(): string | null {
  return legacyWorkspaceId;
}

export function setLegacyWorkspaceId(id: string | null): void {
  legacyWorkspaceId = id && /^ws_\d{3,}$/.test(id) ? id : null;
}

/** Current notes directory, relative to `~/Documents`. */
export function getNotesDir(): string {
  if (!notesDir) throw new Error("El espacio de trabajo todavía no está disponible");
  return notesDir;
}

/**
 * Applies the directory reported by the backend for the active workspace.
 * Returns `true` when it was accepted, `false` when it was rejected and the
 * previous directory was kept.
 */
export function setNotesDir(directory: string | null | undefined): boolean {
  if (typeof directory !== "string") return false;
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!WORKSPACE_DIR_PATTERN.test(normalized)) return false;
  notesDir = normalized;
  return true;
}

/** Block note operations until the backend identifies a valid workspace. */
export function resetNotesDir(): void {
  notesDir = null;
  workspaceEpoch = null;
}

/** True when the notes live in a workspace instead of the legacy root. */
export function isWorkspaceNotesDir(directory: string | null = notesDir): boolean {
  return directory !== null && WORKSPACE_DIR_PATTERN.test(directory);
}

/**
 * Path of one note relative to `~/Documents`. Uses the Tauri `join` so the
 * separator matches the platform.
 */
export async function notesPath(fileName: string): Promise<string> {
  return join(getNotesDir(), fileName);
}
