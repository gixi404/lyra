import test from "node:test";
import assert from "node:assert/strict";
import { runPathOperation } from "../src/utils/pathOperationLock.ts";

test("concurrent path operations run serially and a rejection releases the next operation", async () => {
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = runPathOperation(async () => {
    events.push("first-start");
    await new Promise<void>(resolve => { releaseFirst = resolve; });
    events.push("first-end");
    throw new Error("first failed");
  });
  const second = runPathOperation(async () => {
    events.push("second-start");
    events.push("second-end");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  releaseFirst?.();
  await assert.rejects(first, /first failed/);
  await second;
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});
