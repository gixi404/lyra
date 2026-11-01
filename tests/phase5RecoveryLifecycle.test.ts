import test from "node:test";
import assert from "node:assert/strict";
import {
  _resetRecoveryNotifierForTesting,
  flushRecoveredBatch,
  initRecoveryNotifier,
  type RecoveryNotifierTransport,
} from "../src/utils/recoveryNotifier.ts";
import { useToastStore } from "../src/store/toastStore.ts";

test("AUD-008: concurrent initialization registers once and drains an early event", async () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();
  let registered = 0;
  let removed = 0;
  const transport: RecoveryNotifierTransport = {
    available: () => true,
    register: async handler => {
      registered++;
      handler(["early.md"]);
      return () => { removed++; };
    },
    drain: async () => ["early.md", "later.md"],
  };
  await Promise.all([initRecoveryNotifier(transport), initRecoveryNotifier(transport)]);
  flushRecoveredBatch();
  assert.equal(registered, 1);
  assert.equal(useToastStore.getState().toasts.length, 1);
  assert.match(useToastStore.getState().toasts[0].msg, /2 notas/);
  _resetRecoveryNotifierForTesting();
  assert.equal(removed, 1);
});

test("AUD-008: failed first initialization releases listener and permits retry", async () => {
  _resetRecoveryNotifierForTesting();
  let attempts = 0;
  let removed = 0;
  const transport: RecoveryNotifierTransport = {
    available: () => true,
    register: async () => { attempts++; return () => { removed++; }; },
    drain: async () => { if (attempts === 1) throw new Error("temporary failure"); return []; },
  };
  await initRecoveryNotifier(transport);
  assert.equal(removed, 1);
  await initRecoveryNotifier(transport);
  assert.equal(attempts, 2);
  _resetRecoveryNotifierForTesting();
  assert.equal(removed, 2);
});
