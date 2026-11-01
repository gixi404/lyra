import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceRecoveryLifecycle } from "../src/utils/workspaceRecoveryLifecycle.ts";
import type { WorkspaceSnapshot } from "../src/utils/workspaceState.ts";
import {
  _resetRecoveryNotifierForTesting,
  flushRecoveredBatch,
  initRecoveryNotifier,
  type RecoveryNotifierTransport,
} from "../src/utils/recoveryNotifier.ts";
import { useToastStore } from "../src/store/toastStore.ts";

const directory = "lyra/workspaces/ws_001";

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    required: false,
    done: true,
    phase: "retired",
    workspace: {
      id: "ws_001",
      name: "My workspace",
      kind: "local",
      status: "ready",
      writePolicy: "editable",
      linkageLost: false,
      directory,
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

test("F1 recovery waits for the gate and the installed workspace path", async () => {
  let active: string | null = null;
  let calls = 0;
  const lifecycle = createWorkspaceRecoveryLifecycle(() => active, async () => { calls++; });

  await lifecycle.onFocus();
  assert.equal(calls, 0, "focus during migration must not drain recovery notes");
  assert.throws(() => lifecycle.onReady(snapshot()), /no está listo/);
  assert.equal(calls, 0);

  active = directory;
  assert.throws(() => lifecycle.onReady(snapshot({ required: true, done: false })), /no está listo/);
  assert.throws(() => lifecycle.onReady(snapshot({ workspace: { ...snapshot().workspace!, status: "missing" } })), /no está listo/);
  assert.equal(calls, 0);

  await lifecycle.onReady(snapshot());
  await lifecycle.onFocus();
  assert.equal(calls, 2);
  active = null;
  await lifecycle.onFocus();
  assert.equal(calls, 2, "a closed gate must block a later focus event");
});

test("F1 recovery drains queued notes after migration and again after restart", async () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();
  let active: string | null = null;
  let registers = 0;
  let drains = 0;
  const queued = ["Recovered conflict.md"];
  const transport: RecoveryNotifierTransport = {
    available: () => true,
    register: async () => { registers++; return () => {}; },
    drain: async () => { drains++; return queued.splice(0); },
  };
  const start = () => initRecoveryNotifier(transport);
  const first = createWorkspaceRecoveryLifecycle(() => active, start);
  await first.onFocus();
  assert.equal(registers, 0);
  assert.equal(drains, 0);

  active = directory;
  await first.onReady(snapshot({ draftConflictNames: ["Original.md"] }));
  flushRecoveredBatch();
  assert.equal(registers, 1);
  assert.equal(drains, 1);
  assert.match(useToastStore.getState().toasts[0].msg, /Recovered conflict/);
  await first.onFocus();
  assert.equal(registers, 1, "focus must not install a second listener");

  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();
  active = null;
  queued.push("Recovered after restart.md");
  const restarted = createWorkspaceRecoveryLifecycle(() => active, start);
  await restarted.onFocus();
  assert.equal(drains, 1);
  active = directory;
  await restarted.onReady(snapshot());
  flushRecoveredBatch();
  assert.equal(registers, 2);
  assert.equal(drains, 2);
  assert.match(useToastStore.getState().toasts[0].msg, /Recovered after restart/);
  _resetRecoveryNotifierForTesting();
});
