import test from "node:test";
import assert from "node:assert";
import {
  hasStartupWarnings,
  isGateOpen,
  isWorkspaceReadOnly,
  itemActions,
  pendingWarnings,
  phaseLabel,
  statusLabel,
  type ItemStatus,
  type WorkspaceSnapshot,
} from "../src/utils/workspaceState.ts";

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    required: false,
    done: true,
    phase: "retired",
    workspace: {
      id: "ws_001",
      name: "Mi espacio",
      kind: "local",
      status: "ready",
      writePolicy: "editable",
      linkageLost: false,
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
    restoreDir: "lyra/rescatados/migracion-1700000000",
    drivePaused: false,
    error: null,
    ...overrides,
  };
}

test("F1 gate: the app only starts when the backend opened the gate", () => {
  assert.equal(isGateOpen(snapshot()), true);
  assert.equal(isGateOpen(snapshot({ required: true })), false);
  assert.equal(isGateOpen(snapshot({ done: false })), false);
  assert.equal(isGateOpen(snapshot({ done: false, required: true })), false);
  assert.equal(isGateOpen(snapshot({ workspace: null })), false);
  assert.equal(isGateOpen(snapshot({ workspace: { ...snapshot().workspace!, status: "missing" } })), false);
});

test("F1 gate: an open gate with no pending note shows no warning", () => {
  assert.equal(pendingWarnings(snapshot()), 0);
  assert.equal(hasStartupWarnings(snapshot()), false);
});

test("F1 gate: deferred notes keep warning after the migration ends", () => {
  const pending = snapshot({
    strays: [
      { name: "Aplazada.md", deferred: true, importable: true, detail: "Aplazada" },
    ],
  });
  assert.equal(pendingWarnings(pending), 1);
  assert.equal(hasStartupWarnings(pending), true);
  // The note is still in the root: nothing counts it as migrated.
  assert.equal(pending.items.length, 0);
});

test("F1 gate: symlinks are reported but never offered for import", () => {
  const symlink = snapshot({
    strays: [
      {
        name: "Enlace.md",
        deferred: true,
        importable: false,
        detail: "Enlace simbólico: no se sigue ni se importa",
      },
    ],
  });
  assert.equal(hasStartupWarnings(symlink), true);
  assert.equal(symlink.strays[0].importable, false);
});

test("F1 gate: retire conflicts keep warning even without strays", () => {
  const conflicts = snapshot({
    retireConflicts: [
      {
        name: "Nota.md",
        reason: "source_changed",
        detail: "La original cambió después de copiarse",
      },
    ],
  });
  assert.equal(pendingWarnings(conflicts), 1);
  assert.equal(hasStartupWarnings(conflicts), true);
});

test("F1 gate: warnings are hidden while the migration is still blocking", () => {
  const blocking = snapshot({
    required: true,
    done: false,
    strays: [{ name: "A.md", deferred: false, importable: true, detail: null }],
  });
  assert.equal(isGateOpen(blocking), false);
  // The migration screen owns the problem; the warning panel is for later.
  assert.equal(hasStartupWarnings(blocking), false);
});

test("F1 gate: every blocking status offers at least one non-destructive decision", () => {
  const cases: Array<[ItemStatus, string[]]> = [
    ["destination_conflict", ["keep_both", "adopt_destination"]],
    ["source_changed", ["retry", "adopt_destination"]],
    ["source_missing", ["dismiss"]],
    ["pending_copy", []],
    ["copied", []],
    ["source_symlink", []],
    ["deferred", []],
  ];

  for (const [status, expected] of cases) {
    assert.deepEqual(
      itemActions(status).map(option => option.action),
      expected,
      `unexpected actions for ${status}`
    );
  }
});

test("F1 gate: preserving both versions is the highlighted choice on a name conflict", () => {
  const options = itemActions("destination_conflict");
  assert.equal(options[0].action, "keep_both");
  assert.equal(options[0].primary, true);
  assert.equal(options[1].action, "adopt_destination");
  assert.notEqual(options[1].primary, true);
});

test("F1 gate: labels describe every phase and status without gaps", () => {
  assert.equal(phaseLabel(null), "Preparando el espacio de trabajo");
  assert.notEqual(phaseLabel("preparing"), phaseLabel("copied"));
  assert.notEqual(phaseLabel("prepared"), phaseLabel("activated"));
  assert.equal(phaseLabel("retired"), "Migración completada");

  const statuses: ItemStatus[] = [
    "copied",
    "pending_copy",
    "destination_conflict",
    "source_changed",
    "source_missing",
    "source_symlink",
    "deferred",
  ];
  for (const status of statuses) {
    assert.equal(typeof statusLabel(status), "string");
    assert.ok(statusLabel(status).length > 0);
  }
});

test("F1 gate: an editable ready workspace is not read-only", () => {
  assert.equal(isWorkspaceReadOnly(snapshot()), false);
});

test("F1 gate: no workspace means nothing to protect, but nothing to edit either", () => {
  assert.equal(isWorkspaceReadOnly(snapshot({ workspace: null })), false);
});
