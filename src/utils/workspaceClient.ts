/**
 * Tauri bridge for the workspace/migration commands.
 *
 * Every call answers with a full snapshot, so the boot gate never has to patch
 * local state by hand: the backend already advanced the migration and reports
 * the authoritative result.
 */

import { invoke } from "@tauri-apps/api/core";
import { resetNotesDir, setLegacyWorkspaceId, setNotesDir, setWorkspaceEpoch } from "./workspacePaths.ts";
import type {
  ItemAction,
  RetireAction,
  WorkspaceKind,
  WorkspaceSnapshot,
} from "./workspaceState.ts";

export const WORKSPACE_EVENTS = {
  ready: "lyra:workspace_ready",
} as const;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Last pause flag reported by the backend. It starts paused (fail-closed): the
 * app must not touch Drive until a snapshot confirms it is allowed.
 */
let drivePaused = true;

export function invalidateWorkspace(): void {
  drivePaused = true;
  resetNotesDir();
}

/** True while the backend keeps Drive sync paused (see `drive_sync_paused`). */
export function isDriveSyncPaused(): boolean {
  return drivePaused;
}

async function call(command: string, args?: Record<string, unknown>): Promise<WorkspaceSnapshot> {
  try {
    return await invoke<WorkspaceSnapshot>(command, args);
  } catch (error) {
    invalidateWorkspace();
    throw new Error(messageOf(error));
  }
}

/**
 * Points file operations at the notes directory reported by the backend.
 * Called after every snapshot so the app and the migration never disagree.
 */
export function applySnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  invalidateWorkspace();
  setLegacyWorkspaceId(snapshot.legacyWorkspaceId);
  if (snapshot.workspace && snapshot.done && !snapshot.required && snapshot.workspace.status === "ready") {
    if (!setNotesDir(snapshot.workspace.directory)) {
      throw new Error("El backend devolvió una ruta de espacio de trabajo inválida");
    }
    setWorkspaceEpoch(snapshot.epoch);
    if (!Number.isSafeInteger(snapshot.epoch) || snapshot.epoch <= 0) {
      invalidateWorkspace();
      throw new Error("El backend devolvió una generación de espacio inválida");
    }
  } else if (!snapshot.required) {
    throw new Error("El backend no identificó un espacio de trabajo activo");
  }
  drivePaused = snapshot.drivePaused || snapshot.required || !snapshot.done;
  return snapshot;
}

/** Current state; also makes the migration advance when it can. */
export async function getWorkspaceState(): Promise<WorkspaceSnapshot> {
  return applySnapshot(await call("workspace_get_state"));
}

/** Explicit retry after a recoverable error. */
export async function retryMigration(): Promise<WorkspaceSnapshot> {
  return applySnapshot(await call("migration_retry"));
}

/** Applies a decision to one blocked note. */
export async function resolveMigrationItem(
  name: string,
  action: ItemAction
): Promise<WorkspaceSnapshot> {
  return applySnapshot(await call("migration_resolve_item", { name, action }));
}

/** Copies a note that appeared in the legacy root on purpose. */
export async function importStrayNote(name: string): Promise<WorkspaceSnapshot> {
  return applySnapshot(await call("migration_import_stray", { name }));
}

/** Leaves a note in the root, still reported as pending. */
export async function deferStrayNote(name: string): Promise<WorkspaceSnapshot> {
  return applySnapshot(await call("migration_defer_stray", { name }));
}

/** Resolves a retire conflict without deleting anything. */
export async function resolveRetireConflict(
  name: string,
  action: RetireAction
): Promise<WorkspaceSnapshot> {
  return applySnapshot(await call("migration_resolve_retire", { name, action }));
}

export async function createWorkspace(name: string, kind: WorkspaceKind = "local"): Promise<WorkspaceSnapshot> {
  return managementCall("workspace_create", { name, kind });
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceSnapshot> {
  return managementCall("workspace_rename", { id, name });
}

export async function selectWorkspace(id: string): Promise<WorkspaceSnapshot> {
  return managementCall("workspace_select", { id });
}

export async function deleteWorkspace(id: string): Promise<WorkspaceSnapshot> {
  return managementCall("workspace_delete", { id });
}

async function managementCall(command: string, args: Record<string, unknown>): Promise<WorkspaceSnapshot> {
  try {
    return applySnapshot(await invoke<WorkspaceSnapshot>(command, args));
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

/** True inside the Tauri shell; false in a plain browser or Node test run. */
export function hasTauriBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
  );
}
