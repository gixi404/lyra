import test from "node:test";
import assert from "node:assert/strict";
import { recoverPendingLocalMove } from "../src/utils/pathOperations.ts";

function setup(phase: "awaitingFrontend" | "aborted", oldDraft: string, newDraft?: string) {
  const storage = new Map<string, string>([["lyra-draft:old.md", oldDraft]]);
  if (newDraft !== undefined) storage.set("lyra-draft:new.md", newDraft);
  let pending: object | null = {
    sourcePath: "old.md", destinationPath: "new.md", isFolder: false, phase,
    notes: [{ oldPath: "old.md", newPath: "new.md" }],
  };
  let acknowledgements = 0;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        if (command === "pending_local_move") return pending;
        if (command === "read_draft_file") return null;
        if (command === "acknowledge_local_move") { acknowledgements++; pending = null; return null; }
        return null;
      },
    },
  };
  return { storage, getAcknowledgements: () => acknowledgements };
}

test("restart after Rust move finalizes local draft once and acknowledges", async () => {
  const fixture = setup("awaitingFrontend", "pending edits");
  await recoverPendingLocalMove();
  await recoverPendingLocalMove();
  assert.equal(fixture.storage.get("lyra-draft:new.md"), "pending edits");
  assert.equal(fixture.storage.has("lyra-draft:old.md"), false);
  assert.equal(fixture.getAcknowledgements(), 1);
});

test("conflicting local drafts keep both copies and the durable journal", async () => {
  const fixture = setup("awaitingFrontend", "old edits", "other edits");
  await assert.rejects(recoverPendingLocalMove(), /Conflicting local drafts/);
  assert.equal(fixture.storage.get("lyra-draft:old.md"), "old edits");
  assert.equal(fixture.storage.get("lyra-draft:new.md"), "other edits");
  assert.equal(fixture.getAcknowledgements(), 0);
});

test("aborted move removes only a verified duplicate and keeps the original", async () => {
  const fixture = setup("aborted", "pending edits", "pending edits");
  await recoverPendingLocalMove();
  assert.equal(fixture.storage.get("lyra-draft:old.md"), "pending edits");
  assert.equal(fixture.storage.has("lyra-draft:new.md"), false);
  assert.equal(fixture.getAcknowledgements(), 1);
});
