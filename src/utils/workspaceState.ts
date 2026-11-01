/**
 * Workspace snapshot types and pure decision helpers.
 *
 * This module has no Tauri dependency on purpose: the boot gate, the migration
 * screen and the warnings panel share these predicates, and they can be tested
 * in Node without any IPC.
 *
 * The backend is the only authority on whether the app may start: `required`
 * is computed there. The helpers below never decide to skip a gate; they only
 * describe what the UI should render and which decisions make sense for a
 * given item status.
 */

export type WorkspaceKind = "local" | "google_drive";
export type WorkspaceStatus = "ready" | "missing" | "unreadable";
export type WritePolicy = "editable" | "read_only";

export interface WorkspaceInfo {
  id: string;
  name: string;
  kind: WorkspaceKind;
  status: WorkspaceStatus;
  writePolicy: WritePolicy;
  linkageLost: boolean;
  /** Relative to `~/Documents`, e.g. `lyra/workspaces/ws_001`. */
  directory: string;
}

export type MigrationPhase =
  | "preparing"
  | "copied"
  | "prepared"
  | "activated"
  | "retired";

export type ItemStatus =
  | "copied"
  | "pending_copy"
  | "destination_conflict"
  | "source_changed"
  | "source_missing"
  | "source_symlink"
  | "deferred";

export type Decision = "pending" | "keep_both" | "adopt_destination" | "deferred";

export interface MigrationItemView {
  name: string;
  destName: string;
  status: ItemStatus;
  decision: Decision;
  detail: string | null;
  size: number;
}

export interface MigrationBlock {
  name: string;
  status: ItemStatus;
  detail: string;
}

export interface StrayView {
  name: string;
  /** True for notes the user chose to leave in the root, or symlinks. */
  deferred: boolean;
  /** A regular file that can be imported by hand. */
  importable: boolean;
  detail: string | null;
}

export interface RetireConflict {
  name: string;
  reason: string;
  detail: string;
}

export interface WorkspaceSnapshot {
  required: boolean;
  done: boolean;
  phase: MigrationPhase | null;
  workspace: WorkspaceInfo | null;
  workspaces: WorkspaceInfo[];
  epoch: number;
  legacyWorkspaceId: string | null;
  items: MigrationItemView[];
  blocks: MigrationBlock[];
  strays: StrayView[];
  retireConflicts: RetireConflict[];
  draftConflictNames: string[];
  /** `lyra/rescatados/...` where the originals were kept. */
  restoreDir: string | null;
  drivePaused: boolean;
  error: string | null;
}

export type ItemAction =
  | "keep_both"
  | "adopt_destination"
  | "retry"
  | "defer"
  | "dismiss";

export type RetireAction = "keep_as_pending" | "move_to_rescatados";

export interface ItemActionOption {
  action: ItemAction;
  label: string;
  /** Highlighted in the UI; it is the choice that preserves both versions. */
  primary?: boolean;
}

/** The app may start: the backend opened the gate and a workspace exists. */
export function isGateOpen(snapshot: WorkspaceSnapshot): boolean {
  return snapshot.done && !snapshot.required && snapshot.workspace?.status === "ready";
}

/**
 * Notes that still deserve a warning: deferred notes and symlinks left in the
 * root, plus retire conflicts. They are reported after the migration ends too,
 * so the warning never disappears on its own.
 */
export function pendingWarnings(snapshot: WorkspaceSnapshot): number {
  return snapshot.strays.length + snapshot.retireConflicts.length;
}

/** The active workspace cannot be edited (linkage lost or missing directory). */
export function isWorkspaceReadOnly(snapshot: WorkspaceSnapshot): boolean {
  if (!snapshot.workspace) return false;
  return (
    snapshot.workspace.writePolicy === "read_only" ||
    snapshot.workspace.status !== "ready"
  );
}

/** Show the non-blocking warnings panel once the app can start. */
export function hasStartupWarnings(snapshot: WorkspaceSnapshot): boolean {
  return isGateOpen(snapshot) && (pendingWarnings(snapshot) > 0 || isWorkspaceReadOnly(snapshot));
}

/**
 * Decisions offered for one item. A `pending_copy` is copied automatically by
 * the next snapshot, and `copied`/`deferred`/`source_symlink` need no decision,
 * so they return an empty list.
 */
export function itemActions(status: ItemStatus): ItemActionOption[] {
  switch (status) {
    case "destination_conflict":
      return [
        { action: "keep_both", label: "Conservar ambas", primary: true },
        { action: "adopt_destination", label: "Usar la del espacio" },
      ];
    case "source_changed":
      return [
        { action: "retry", label: "Copiar la versión actual", primary: true },
        { action: "adopt_destination", label: "Usar la del espacio" },
      ];
    case "source_missing":
      return [{ action: "dismiss", label: "Descartar el aviso" }];
    case "pending_copy":
    case "copied":
    case "source_symlink":
    case "deferred":
      return [];
  }
}

export function phaseLabel(phase: MigrationPhase | null): string {
  switch (phase) {
    case "preparing":
      return "Revisando la carpeta principal";
    case "copied":
      return "Copiando notas";
    case "prepared":
      return "Listo para activar el espacio";
    case "activated":
      return "Guardando los originales";
    case "retired":
      return "Migración completada";
    default:
      return "Preparando el espacio de trabajo";
  }
}

export function statusLabel(status: ItemStatus): string {
  switch (status) {
    case "copied":
      return "Copiada";
    case "pending_copy":
      return "Pendiente de copia";
    case "destination_conflict":
      return "Conflicto de nombre";
    case "source_changed":
      return "La original cambió";
    case "source_missing":
      return "La original ya no existe";
    case "source_symlink":
      return "Enlace simbólico (no se migra)";
    case "deferred":
      return "Aplazada";
  }
}
