import test from "node:test";
import assert from "node:assert/strict";
import { workspaceNoteKeys } from "../src/utils/workspaceNoteKeys.ts";
import { runPreparedWorkspaceSwitch } from "../src/utils/workspaceTransition.ts";
import { fileStore } from "../src/store/fileStore.ts";
import { _resetRecoveryNotifierForTesting, flushRecoveredBatch, initRecoveryNotifierForWorkspace, type RecoveryNotifierTransport } from "../src/utils/recoveryNotifier.ts";
import { useToastStore } from "../src/store/toastStore.ts";
import { workspaceHasPendingDrafts } from "../src/utils/workspaceDeletion.ts";

test("F2 note keys keep same-name drafts and editor metadata separate", () => {
  const first = workspaceNoteKeys(["Same.md"], "", "lyra-draft", "ws_001", "ws_001");
  const second = workspaceNoteKeys(["Same.md"], "", "lyra-draft", "ws_002", "ws_001");
  assert.notEqual(first[0], second[0]);
  assert.equal(first.includes("lyra-draft:Same.md"), true, "the migrated workspace can read F1 drafts");
  assert.equal(second.includes("lyra-draft:Same.md"), false);
  assert.deepEqual(workspaceNoteKeys(["Same.md"], "-scroll", "", "ws_002", "ws_001"),
    ["lyra-workspace:ws_002:Same.md-scroll"]);
  assert.equal(workspaceNoteKeys(["Old.md"], "", "lyra-draft", "ws_007", "ws_007")
    .includes("lyra-draft:Old.md"), true, "the F1 id need not be ws_001");
});

test("F2 safe deletion detects pending scoped and migrated drafts", () => {
  const keys = ["lyra-workspace:ws_002:lyra-draft:Same.md", "lyra-draft:Old.md"];
  assert.equal(workspaceHasPendingDrafts(keys, "ws_002", "ws_001"), true);
  assert.equal(workspaceHasPendingDrafts(keys, "ws_001", "ws_001"), true);
  assert.equal(workspaceHasPendingDrafts(keys, "ws_003", "ws_001"), false);
});

test("F2 switch waits for real editor persistence before selecting", async () => {
  let finishSave: (() => void) | undefined;
  const save = new Promise<void>(resolve => { finishSave = resolve; });
  const order: string[] = [];
  const switching = runPreparedWorkspaceSwitch({
    flushVisualCommits: () => { order.push("visual"); },
    prepareEditors: async () => { order.push("prepare"); await save; return true; },
    persistPreferences: async () => { order.push("preferences"); },
    select: async () => { order.push("select"); return "ws_002"; },
  });
  await Promise.resolve();
  assert.deepEqual(order, ["visual", "prepare"]);
  finishSave?.();
  assert.equal(await switching, "ws_002");
  assert.deepEqual(order, ["visual", "prepare", "preferences", "prepare", "select"]);
});

test("F2 failed save or failed preference persistence never selects another workspace", async () => {
  let selected = 0;
  await assert.rejects(runPreparedWorkspaceSwitch({
    flushVisualCommits: () => {}, prepareEditors: async () => false,
    persistPreferences: async () => {}, select: async () => { selected++; },
  }), /sin guardar/);
  await assert.rejects(runPreparedWorkspaceSwitch({
    flushVisualCommits: () => {}, prepareEditors: async () => true,
    persistPreferences: async () => { throw new Error("disk full"); },
    select: async () => { selected++; },
  }), /disk full/);
  let checks = 0;
  await assert.rejects(runPreparedWorkspaceSwitch({
    flushVisualCommits: () => {}, prepareEditors: async () => ++checks === 1,
    persistPreferences: async () => {}, select: async () => { selected++; },
  }), /sin guardar/);
  assert.equal(selected, 0);
});

test("F2 workspace reset removes the previous selection, list and pending animation", () => {
  const state = fileStore.getState();
  state.setFilesWithStats(["Same.md"], { "Same.md": { mtime: 1, birthtime: 1 } });
  state.setSelectedFile({ name: "Same.md", content: "first workspace" });
  let committed = false;
  state.scheduleExitAnimation("Same.md", () => { committed = true; }, 60_000);
  fileStore.getState().resetForWorkspace();
  const after = fileStore.getState();
  assert.deepEqual(after.files, []);
  assert.equal(after.selectedFile.name, "");
  assert.deepEqual(after.statsMap, {});
  assert.deepEqual(after.exitingFiles, []);
  assert.equal(after.isInitialized, false);
  assert.equal(committed, false);
});

test("F2 recovery checks the new workspace and does not dedupe against the old one", async () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();
  let registered = 0;
  let pending = ["Same.md"];
  const transport: RecoveryNotifierTransport = {
    available: () => true,
    register: async () => { registered++; return () => {}; },
    drain: async () => pending.splice(0),
  };
  await initRecoveryNotifierForWorkspace("lyra/workspaces/ws_001", transport);
  flushRecoveredBatch();
  assert.equal(useToastStore.getState().toasts.length, 1);
  pending = ["Same.md"];
  await initRecoveryNotifierForWorkspace("lyra/workspaces/ws_002", transport);
  flushRecoveredBatch();
  assert.equal(useToastStore.getState().toasts.length, 2);
  assert.equal(registered, 1);
  _resetRecoveryNotifierForTesting();
});
