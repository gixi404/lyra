import test from "node:test";
import assert from "node:assert/strict";
import { deleteArchivedBatch } from "../src/utils/archiveDeletion.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("bulk deletion waits for the backend and keeps each row reserved", async () => {
  const pending = deferred();
  const events: string[] = [];
  const run = deleteArchivedBatch(
    ["A.md"],
    async name => { events.push(`delete:${name}`); await pending.promise; },
    name => events.push(`retain:${name}`),
    name => events.push(`release:${name}`),
  );
  assert.deepEqual(events, ["retain:A.md", "delete:A.md"]);
  pending.resolve();
  assert.deepEqual(await run, { deleted: ["A.md"], failed: [] });
  assert.deepEqual(events, ["retain:A.md", "delete:A.md"]);
});

test("bulk deletion reports partial results and releases failed rows", async () => {
  const released: string[] = [];
  const result = await deleteArchivedBatch(
    ["A.md", "B.md", "C.md"],
    async name => { if (name === "B.md") throw new Error("disk error"); },
    () => {},
    name => released.push(name),
  );
  assert.deepEqual(result.deleted, ["A.md", "C.md"]);
  assert.deepEqual(result.failed.map(item => item.name), ["B.md"]);
  assert.deepEqual(released, ["B.md"]);
});
