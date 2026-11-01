import test from "node:test";
import assert from "node:assert/strict";
import { createLogoutConfirmation } from "../src/utils/logoutConfirmation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("AUD-013: opening then cancelling does not invoke logout", () => {
  let calls = 0;
  const confirmation = createLogoutConfirmation(async () => { calls++; return true; });
  confirmation.open();
  confirmation.cancel();
  return confirmation.confirm().then(result => {
    assert.equal(result, false);
    assert.equal(calls, 0);
  });
});

test("AUD-013: concurrent confirmation invokes logout once", async () => {
  const operation = deferred<boolean>();
  let calls = 0;
  const confirmation = createLogoutConfirmation(() => { calls++; return operation.promise; });
  confirmation.open();
  const first = confirmation.confirm();
  assert.equal(confirmation.isPending(), true);
  assert.equal(await confirmation.confirm(), false);
  assert.equal(calls, 1);
  operation.resolve(true);
  assert.equal(await first, true);
  assert.equal(confirmation.isPending(), false);
});

test("AUD-013: failure leaves confirmation retryable", async () => {
  let calls = 0;
  const confirmation = createLogoutConfirmation(async () => ++calls > 1);
  confirmation.open();
  assert.equal(await confirmation.confirm(), false);
  assert.equal(await confirmation.confirm(), true);
  assert.equal(calls, 2);
});

test("AUD-013: rejected logout clears pending state", async () => {
  const confirmation = createLogoutConfirmation(async () => { throw new Error("IPC failed"); });
  confirmation.open();
  await assert.rejects(confirmation.confirm(), /IPC failed/);
  assert.equal(confirmation.isPending(), false);
});
