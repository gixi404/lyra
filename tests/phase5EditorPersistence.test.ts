import test from "node:test";
import assert from "node:assert/strict";
import { EditorSyncCoordinator } from "../src/utils/editorSyncCoordinator.ts";
import {
  clearDetachedSaveFailure,
  flushEditorDrafts,
  getUpdateInstallInProgress,
  markDetachedSaveFailure,
  prepareEditorsForRelaunch,
  registerEditorSession,
  runPreparedInstall,
  runPreparedRelaunch,
  subscribeUpdateInstall,
} from "../src/utils/editorPersistence.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("AUD-007: changing documents cannot silently reuse a coordinator", () => {
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "A", saveFileContent: async () => {}, readFileContent: async () => "A",
  });
  assert.throws(() => coordinator.updateOptions({ fileName: "B.md" }));
  assert.throws(() => coordinator.setCleanContent("B", "B.md"));
  assert.equal(coordinator.getFileName(), "A.md");
  assert.equal(coordinator.getLatestContent(), "A");
});

test("AUD-007: selection handoff flushes the old note draft before rendering another", () => {
  const drafts = new Map<string, string>();
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "A",
    saveFileContent: async () => {}, readFileContent: async () => "A",
    writeDraft: (name, content) => { drafts.set(name, content); },
  });
  const release = registerEditorSession(coordinator);
  coordinator.handleUserContentChange("A pending");
  flushEditorDrafts();
  assert.equal(drafts.get("A.md"), "A pending");
  release();
});

test("AUD-007/012: pending A save stays on A and blocks relaunch while B is open", async () => {
  const gate = deferred();
  const started = deferred();
  const disk = new Map([["A.md", "A"], ["B.md", "B"]]);
  const save = async (name: string, content: string) => {
    if (name === "A.md") { started.resolve(); await gate.promise; }
    disk.set(name, content);
  };
  const a = new EditorSyncCoordinator({ fileName: "A.md", initialContent: "A", saveFileContent: save, readFileContent: async name => disk.get(name) ?? "" });
  const b = new EditorSyncCoordinator({ fileName: "B.md", initialContent: "B", saveFileContent: save, readFileContent: async name => disk.get(name) ?? "" });
  const releaseA = registerEditorSession(a);
  const releaseB = registerEditorSession(b);
  a.handleUserContentChange("A edited");
  const pending = a.persistLatestToDisk();
  await started.promise;
  let prepared = false;
  const preparation = prepareEditorsForRelaunch(1000).then(value => { prepared = true; return value; });
  await Promise.resolve();
  assert.equal(prepared, false);
  assert.equal(disk.get("B.md"), "B");
  gate.resolve();
  assert.equal(await pending, true);
  assert.equal(await preparation, true);
  assert.equal(disk.get("A.md"), "A edited");
  assert.equal(disk.get("B.md"), "B");
  releaseA(); releaseB();
});

test("AUD-007: rapid A to B to A keeps A draft and B content separate", async () => {
  const drafts = new Map<string, string>();
  const disk = new Map([["A.md", "A"], ["B.md", "B"]]);
  const options = (name: string, content: string) => ({
    fileName: name, initialContent: content,
    saveFileContent: async (target: string, value: string) => { disk.set(target, value); },
    readFileContent: async (target: string) => disk.get(target) ?? "",
    writeDraft: (target: string, value: string) => { drafts.set(target, value); },
  });
  const firstA = new EditorSyncCoordinator(options("A.md", "A"));
  const releaseA = registerEditorSession(firstA);
  firstA.handleUserContentChange("A edited");
  flushEditorDrafts();
  const b = new EditorSyncCoordinator(options("B.md", "B"));
  const releaseB = registerEditorSession(b);
  assert.equal(b.getLatestContent(), "B");
  const secondA = new EditorSyncCoordinator(options("A.md", drafts.get("A.md") ?? "A"));
  assert.equal(secondA.getLatestContent(), "A edited");
  assert.equal(b.getLatestContent(), "B");
  assert.equal(await firstA.handleUnmount(), true);
  assert.equal(disk.get("A.md"), "A edited");
  assert.equal(disk.get("B.md"), "B");
  releaseA(); releaseB();
});

test("AUD-012: failed atomic save blocks restart and retry succeeds", async () => {
  let fail = true;
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "A",
    saveFileContent: async () => { if (fail) throw new Error("disk full"); },
    readFileContent: async () => "A",
  });
  const release = registerEditorSession(coordinator);
  coordinator.handleUserContentChange("new text");
  assert.equal(await prepareEditorsForRelaunch(), false);
  assert.equal(coordinator.getIsDirty(), true);
  fail = false;
  assert.equal(await prepareEditorsForRelaunch(), true);
  assert.equal(coordinator.getIsDirty(), false);
  release();
});

test("AUD-012: an edit during preparation is also persisted", async () => {
  const gate = deferred();
  const started = deferred();
  const writes: string[] = [];
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "A",
    saveFileContent: async (_name, content) => {
      if (content === "first") { started.resolve(); await gate.promise; }
      writes.push(content);
    },
    readFileContent: async () => "A",
  });
  const release = registerEditorSession(coordinator);
  coordinator.handleUserContentChange("first");
  const preparation = prepareEditorsForRelaunch(1000);
  await started.promise;
  coordinator.handleUserContentChange("second");
  gate.resolve();
  assert.equal(await preparation, true);
  assert.deepEqual(writes, ["first", "second"]);
  release();
});

test("AUD-012: a save that never confirms blocks restart after timeout", async () => {
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "A",
    saveFileContent: async () => new Promise<void>(() => {}),
    readFileContent: async () => "A",
  });
  const release = registerEditorSession(coordinator);
  coordinator.handleUserContentChange("pending");
  assert.equal(await prepareEditorsForRelaunch(5), false);
  release();
});

test("AUD-007: a new edit during conflict rescue remains in the active session", async () => {
  const gate = deferred();
  const started = deferred();
  const drafts: string[] = [];
  const disk = new Map([["A.md", "remote"]]);
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "original",
    saveFileContent: async (name, content) => {
      if (name.includes("edición local")) { started.resolve(); await gate.promise; }
      disk.set(name, content);
    },
    readFileContent: async name => disk.get(name) ?? "",
    writeDraft: (_name, content) => { drafts.push(content); },
    checkFileExists: async () => false,
  });
  coordinator.handleUserContentChange("first edit");
  const reconciliation = coordinator.handleSyncFinished({ downloaded: ["A.md"], deleted_remote: [] });
  await started.promise;
  coordinator.handleUserContentChange("second edit");
  gate.resolve();
  await reconciliation;
  assert.equal(coordinator.getLatestContent(), "second edit");
  assert.equal(coordinator.getIsDirty(), true);
  assert.ok(drafts.includes("first edit"));
  coordinator.flushDraft();
});

test("AUD-012: failed save after unmount blocks relaunch until resolved", async () => {
  markDetachedSaveFailure("failed.md");
  assert.equal(await prepareEditorsForRelaunch(), false);
  clearDetachedSaveFailure("failed.md");
  assert.equal(await prepareEditorsForRelaunch(), true);
});

test("AUD-012: relaunch runs only after confirmed saves and preferences", async () => {
  const calls: string[] = [];
  const completed = await runPreparedRelaunch(
    async () => { calls.push("prepare"); return true; },
    async () => { calls.push("preferences"); },
    async () => { calls.push("relaunch"); },
  );
  assert.equal(completed, true);
  assert.deepEqual(calls, ["prepare", "preferences", "prepare", "relaunch"]);
});

test("AUD-012: a new edit before the final check cancels relaunch", async () => {
  const calls: string[] = [];
  let checks = 0;
  const completed = await runPreparedRelaunch(
    async () => { checks++; return checks === 1; },
    async () => { calls.push("preferences"); },
    async () => { calls.push("relaunch"); },
  );
  assert.equal(completed, false);
  assert.deepEqual(calls, ["preferences"]);
});

test("FINAL-001: install waits for the atomic save and preferences", async () => {
  const saveGate = deferred();
  const saveStarted = deferred();
  const installGate = deferred();
  const installStarted = deferred();
  const calls: string[] = [];
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "old",
    saveFileContent: async () => { saveStarted.resolve(); await saveGate.promise; calls.push("saved"); },
    readFileContent: async () => "old",
  });
  const release = registerEditorSession(coordinator);
  coordinator.handleUserContentChange("new");
  const installation = runPreparedInstall(
    () => prepareEditorsForRelaunch(),
    async () => { calls.push("preferences"); },
    async () => { calls.push("install"); installStarted.resolve(); await installGate.promise; },
  );
  await saveStarted.promise;
  assert.deepEqual(calls, []);
  assert.equal(getUpdateInstallInProgress(), false);
  saveGate.resolve();
  await installStarted.promise;
  assert.deepEqual(calls, ["saved", "preferences", "install"]);
  assert.equal(getUpdateInstallInProgress(), true);
  coordinator.handleUserContentChange("must not be accepted while installing");
  assert.equal(coordinator.getLatestContent(), "new");
  installGate.resolve();
  assert.equal(await installation, true);
  assert.equal(getUpdateInstallInProgress(), false);
  release();
});

test("FINAL-001: failed save blocks installation and allows a retry", async () => {
  let fail = true;
  let installs = 0;
  const coordinator = new EditorSyncCoordinator({
    fileName: "A.md", initialContent: "old",
    saveFileContent: async () => { if (fail) throw new Error("disk full"); },
    readFileContent: async () => "old",
  });
  const release = registerEditorSession(coordinator);
  coordinator.handleUserContentChange("new");
  const attempt = () => runPreparedInstall(
    () => prepareEditorsForRelaunch(), async () => {}, async () => { installs++; },
  );
  assert.equal(await attempt(), false);
  assert.equal(installs, 0);
  assert.equal(coordinator.getIsDirty(), true);
  fail = false;
  assert.equal(await attempt(), true);
  assert.equal(installs, 1);
  release();
});

test("FINAL-001: install failure releases the editor barrier", async () => {
  const states: boolean[] = [];
  const unsubscribe = subscribeUpdateInstall(() => states.push(getUpdateInstallInProgress()));
  await assert.rejects(runPreparedInstall(
    async () => true, async () => {}, async () => { throw new Error("installer failed"); },
  ));
  assert.deepEqual(states, [true, false]);
  assert.equal(getUpdateInstallInProgress(), false);
  unsubscribe();
});
