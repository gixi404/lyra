import test from "node:test";
import assert from "node:assert";
import {
  hasStartupWarnings,
  isGateOpen,
  isWorkspaceReadOnly,
  pendingWarnings,
  type WorkspaceSnapshot,
} from "../src/utils/workspaceState.ts";
import { applySnapshot, isDriveSyncPaused } from "../src/utils/workspaceClient.ts";
import { getNotesDir, resetNotesDir } from "../src/utils/workspacePaths.ts";

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    required: false,
    done: true,
    phase: "retired",
    workspace: {
      id: "ws_001",
      name: "Mi espacio",
      kind: "google_drive",
      status: "ready",
      writePolicy: "read_only",
      linkageLost: true,
      directory: "lyra/workspaces/ws_001",
    },
    workspaces: [],
    legacyWorkspaceId: "ws_001",
    epoch: 1,
    items: [],
    blocks: [],
    strays: [],
    retireConflicts: [],
    draftConflictNames: [],
    restoreDir: null,
    drivePaused: true,
    error: null,
    ...overrides,
  };
}

test("F1 linkage: a lost link opens the app but blocks editing", () => {
  const lost = snapshot();
  assert.equal(isGateOpen(lost), true);
  assert.equal(isWorkspaceReadOnly(lost), true);
});

test("F1 linkage: the read-only reminder is persistent, not a one-time dialog", () => {
  const lost = snapshot();
  const readOnly = isWorkspaceReadOnly(lost);
  // It stays visible on every snapshot while the link is missing.
  assert.equal(hasStartupWarnings(lost), true);
  assert.equal(hasStartupWarnings({ ...lost }), true);
  assert.equal(readOnly, true);
});

test("F1 linkage: the reminder does not depend on pending notes", () => {
  const lost = snapshot();
  assert.equal(pendingWarnings(lost), 0);
  assert.equal(hasStartupWarnings(lost), true);

  const recovered = snapshot({
    workspace: {
      ...snapshot().workspace!,
      writePolicy: "editable",
      linkageLost: false,
    },
  });
  assert.equal(isWorkspaceReadOnly(recovered), false);
  assert.equal(hasStartupWarnings(recovered), false);
});

test("F1 linkage: a missing workspace folder is read-only too", () => {
  for (const status of ["missing", "unreadable"] as const) {
    const broken = snapshot({
      workspace: { ...snapshot().workspace!, status, writePolicy: "editable", linkageLost: false },
    });
    assert.equal(isWorkspaceReadOnly(broken), true, `status ${status} must be read-only`);
  }
});

test("F1 linkage: reads are still pointed at the workspace, so notes stay visible", () => {
  resetNotesDir();
  applySnapshot(snapshot());
  // The space cannot be edited, but its notes must remain readable.
  assert.equal(getNotesDir(), "lyra/workspaces/ws_001");
  assert.equal(isWorkspaceReadOnly(snapshot()), true);
});

test("F1 linkage: Drive stays paused (fail-closed) while the backend says so", () => {
  applySnapshot(snapshot({ drivePaused: true }));
  assert.equal(isDriveSyncPaused(), true);

  applySnapshot(snapshot({ drivePaused: false }));
  assert.equal(isDriveSyncPaused(), false);

  resetNotesDir();
});

test("F1 linkage: without a workspace note access remains blocked", () => {
  resetNotesDir();
  applySnapshot(snapshot({ workspace: null, required: true, done: false }));
  assert.throws(() => getNotesDir(), /espacio de trabajo/);
});

test("F1 linkage: invalid backend paths invalidate a previously active workspace", () => {
  applySnapshot(snapshot());
  assert.throws(() => applySnapshot(snapshot({
    workspace: { ...snapshot().workspace!, directory: "lyra" },
  })), /ruta de espacio de trabajo inválida/);
  assert.throws(() => getNotesDir(), /espacio de trabajo/);
  assert.equal(isDriveSyncPaused(), true);
});
