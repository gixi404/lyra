import test from "node:test";
import assert from "node:assert/strict";
import { isDeletionInProgress, runExclusiveDeletion } from "../src/utils/noteDeletion.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("slow deletion keeps the dialog busy and confirms only after backend completion", async () => {
  const backend = deferred();
  const calls: string[] = [];
  const callbacks = {
    setBusy: (busy: boolean) => calls.push(busy ? "busy" : "idle"),
    retain: (name: string) => calls.push(`retain:${name}`),
    release: (name: string) => calls.push(`release:${name}`),
    deleteNote: (_name: string) => { calls.push("backend"); return backend.promise; },
    confirmed: (name: string) => calls.push(`confirmed:${name}`),
    failed: (_error: unknown) => calls.push("failed"),
  };
  const first = runExclusiveDeletion("tareas.md", callbacks);
  await runExclusiveDeletion("tareas.md", callbacks);
  assert.deepEqual(calls, ["busy", "retain:tareas.md", "backend"]);
  assert.equal(isDeletionInProgress("tareas.md"), true);
  backend.resolve();
  await first;
  assert.deepEqual(calls, ["busy", "retain:tareas.md", "backend", "confirmed:tareas.md", "idle"]);
  assert.equal(isDeletionInProgress("tareas.md"), false);
});

test("failed deletion releases the row, reports error, and permits retry", async () => {
  const calls: string[] = [];
  let fails = true;
  const callbacks = {
    setBusy: (busy: boolean) => calls.push(busy ? "busy" : "idle"),
    retain: (_name: string) => calls.push("retain"),
    release: (_name: string) => calls.push("release"),
    deleteNote: async (_name: string) => { if (fails) throw new Error("backend rejected"); },
    confirmed: (_name: string) => calls.push("confirmed"),
    failed: (_error: unknown) => calls.push("failed"),
  };
  await runExclusiveDeletion("tareas.md", callbacks);
  assert.deepEqual(calls, ["busy", "retain", "release", "failed", "idle"]);
  fails = false;
  await runExclusiveDeletion("tareas.md", callbacks);
  assert.deepEqual(calls.slice(5), ["busy", "retain", "confirmed", "idle"]);
});
