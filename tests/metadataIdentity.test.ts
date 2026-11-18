import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveMetadataForReplacement, bindMetadata, metadataMatches, prepareMetadataWrite, refreshMetadataIdentities,
  remapMetadataBindings,
} from "../src/utils/metadataIdentity.ts";
import { getVisibleSegment, remapVisibleNames, setVisibleNameForPath } from "../src/utils/visibleNames.ts";
import { getFolderIconColors, getFolderTextColors, getFolderIcons, setFolderColor, setFolderIcon } from "../src/utils/folderAppearance.ts";
import { readFolderExpandedState } from "../src/utils/folderTree.ts";
import { startLocalFirstListInitialization } from "../src/utils/listInitialization.ts";

function fixture() {
  const storage = new Map<string, string>();
  const identities = new Map<string, string>();
  const legacyBlocked = new Set<string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { kind: string; path: string; legacy?: boolean }) => {
        if (command === "metadata_identity") {
          const key = `${args.kind}:${args.path}`;
          return args.legacy && legacyBlocked.has(key) ? null : identities.get(key) ?? null;
        }
        return undefined;
      },
    },
  };
  return { storage, identities, legacyBlocked };
}

test("AUD2-008: bound file metadata survives a move and rejects a reused path with identical content", async () => {
  const { storage, identities } = fixture();
  identities.set("file:note.md", "id-a");
  prepareMetadataWrite("file", "note.md");
  setVisibleNameForPath("note.md", "file", "My note.md");
  assert.equal(await bindMetadata("file", "note.md"), true);
  assert.equal(getVisibleSegment("note.md", "file"), "My note.md");
  identities.delete("file:note.md");
  identities.set("file:moved.md", "id-a");
  remapVisibleNames([{ oldPath: "note.md", newPath: "moved.md" }]);
  remapMetadataBindings([{ oldPath: "note.md", newPath: "moved.md" }]);
  await refreshMetadataIdentities(["moved.md"], []);
  assert.equal(metadataMatches("file", "moved.md"), true);
  identities.set("file:moved.md", "id-b");
  await refreshMetadataIdentities(["moved.md"], []);
  assert.equal(getVisibleSegment("moved.md", "file"), undefined);
  assert.ok(storage.get("metadataIdentityHistory")?.includes("id-a"));
});

test("AUD2-008: legacy folder appearance binds on first listing and a new marker cannot inherit it", async () => {
  const { storage, identities } = fixture();
  storage.set("folderIcons", JSON.stringify({ Folder: "star" }));
  identities.set("folder:Folder", "marker-b:physical-b");
  await refreshMetadataIdentities([], ["Folder"]);
  assert.equal(getFolderIcons().Folder, "star");
  prepareMetadataWrite("folder", "Folder");
  setFolderIcon("Folder", "book");
  assert.equal(await bindMetadata("folder", "Folder"), true);
  assert.equal(getFolderIcons().Folder, "book");
  identities.set("folder:Folder", "marker-c:physical-c");
  await refreshMetadataIdentities([], ["Folder"]);
  assert.equal(getFolderIcons().Folder, undefined);
  assert.ok(storage.get("metadataIdentityHistory")?.includes("book"));
});

test("AUD2-008: paired color updates retain both values while identity binding is pending", async () => {
  const { identities } = fixture();
  identities.set("folder:Work", "marker-a:physical-a");
  setFolderColor("Work", "blue");
  assert.equal(await bindMetadata("folder", "Work"), true);
  assert.equal(getFolderTextColors().Work, "blue");
  assert.equal(getFolderIconColors().Work, "blue");
});

test("AUD2-008: restart validates the same identity and archives legacy metadata on replacement", async () => {
  const { storage, identities } = fixture();
  identities.set("file:note.md", "stable-id");
  setVisibleNameForPath("note.md", "file", "Visible.md");
  assert.equal(await bindMetadata("file", "note.md"), true);
  await refreshMetadataIdentities(["note.md"], []);
  assert.equal(getVisibleSegment("note.md", "file"), "Visible.md");
  await refreshMetadataIdentities([], []);
  await refreshMetadataIdentities(["note.md"], []);
  assert.equal(getVisibleSegment("note.md", "file"), "Visible.md");
  archiveMetadataForReplacement("file", "note.md");
  assert.equal(getVisibleSegment("note.md", "file"), undefined);
  assert.ok(storage.get("metadataIdentityHistory")?.includes("Visible.md"));
});

test("AUD2-008: binding persistence failure keeps the visible-name bytes for retry", async () => {
  const { storage, identities } = fixture();
  identities.set("file:note.md", "stable-id");
  const localStorage = (globalThis as unknown as { window: { localStorage: { setItem: (key: string, value: string) => void } } }).window.localStorage;
  const originalSet = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === "metadataIdentityBindings") throw new Error("injected preference failure");
    originalSet(key, value);
  };
  prepareMetadataWrite("file", "note.md");
  setVisibleNameForPath("note.md", "file", "Kept.md");
  await assert.rejects(bindMetadata("file", "note.md"), /injected preference failure/);
  assert.equal(JSON.parse(storage.get("noteVisibleNames") ?? "{}")["note.md"], "Kept.md");
  localStorage.setItem = originalSet;
  assert.equal(await bindMetadata("file", "note.md"), true);
  assert.equal(getVisibleSegment("note.md", "file"), "Kept.md");
});

test("AUD2-008: development metadata is consolidated on first listing unless reuse is evidenced", async () => {
  const { storage, identities, legacyBlocked } = fixture();
  storage.set("noteVisibleNames", JSON.stringify({ "current.md": "Current title.md", "reused.md": "Old title.md" }));
  storage.set("folderIcons", JSON.stringify({ Work: "star" }));
  identities.set("file:current.md", "current-id");
  identities.set("file:reused.md", "new-id");
  identities.set("folder:Work", "folder-marker:physical-id");
  legacyBlocked.add("file:reused.md");
  await refreshMetadataIdentities(["current.md", "reused.md"], ["Work"]);
  assert.equal(getVisibleSegment("current.md", "file"), "Current title.md");
  assert.equal(getFolderIcons().Work, "star");
  assert.equal(getVisibleSegment("reused.md", "file"), undefined);
  assert.equal(JSON.parse(storage.get("noteVisibleNames") ?? "{}")["reused.md"], "Old title.md");
  const bindings = JSON.parse(storage.get("metadataIdentityBindings") ?? "{}");
  assert.equal(bindings["file:current.md"], "current-id");
  assert.equal(bindings["file:reused.md"], undefined);
});

test("returning to the explorer retains verified nested expansion while identities refresh", async () => {
  const { storage, identities } = fixture();
  storage.set("folderExpanded", JSON.stringify({ "root:lyra": true, Work: true, "Work/Open": true, "Work/Open/Closed": false, Other: false }));
  for (const path of ["Work", "Work/Open", "Work/Open/Closed", "Other"]) {
    identities.set(`folder:${path}`, `id:${path}`);
  }
  const folders = ["Work", "Work/Open", "Work/Open/Closed", "Other"];
  await refreshMetadataIdentities(["Work/Open/note.md"], folders);
  const localStorage = (globalThis as unknown as { window: { localStorage: Storage; __TAURI_INTERNALS__: { invoke: (command: string, args: { kind: string; path: string }) => Promise<unknown> } } }).window;
  const expected = readFolderExpandedState(localStorage.localStorage);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalInvoke = localStorage.__TAURI_INTERNALS__.invoke;
  localStorage.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "metadata_identity") await gate;
    return originalInvoke(command, args);
  };
  for (let visit = 0; visit < 3; visit++) {
    const refresh = refreshMetadataIdentities(["Work/Open/note.md"], folders);
    assert.deepEqual(readFolderExpandedState(localStorage.localStorage), expected);
    release();
    await refresh;
    assert.deepEqual(readFolderExpandedState(localStorage.localStorage), expected);
  }
  identities.set("folder:Work/Open/Closed", "replacement-id");
  await refreshMetadataIdentities(["Work/Open/note.md"], folders);
  assert.equal(readFolderExpandedState(localStorage.localStorage)["Work/Open/Closed"], undefined);
  assert.equal(JSON.parse(storage.get("folderExpanded") ?? "{}")["Work/Open/Closed"], undefined);
});

test("cold start publishes no provisional expansion while preferences and identities hydrate", async () => {
  for (const [index, expanded] of [
    { A: false, B: false, "B/Sub": false },
    { A: true, B: true, "B/Sub": true },
    { A: true, B: false, "B/Sub": true },
  ].entries()) {
    const { storage, identities } = fixture();
    const named = (path: string) => path.replace(/^([AB])/, `$1${index}`);
    const paths = Object.keys(expanded).map(named);
    const expected = Object.fromEntries(Object.entries(expanded).map(([path, value]) => [named(path), value]));
    for (const path of paths) identities.set(`folder:${path}`, `id:${path}`);
    let releasePreferences!: () => void;
    const preferencesReady = new Promise<void>(resolve => { releasePreferences = resolve; });
    let releaseIdentities!: () => void;
    const identitiesReady = new Promise<void>(resolve => { releaseIdentities = resolve; });
    const localStorage = (globalThis as unknown as { window: { localStorage: Storage; __TAURI_INTERNALS__: { invoke: (command: string, args: { kind: string; path: string }) => Promise<unknown> } } }).window;
    const originalInvoke = localStorage.__TAURI_INTERNALS__.invoke;
    localStorage.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "metadata_identity") await identitiesReady;
      return originalInvoke(command, args);
    };
    const published: Record<string, boolean>[] = [];
    let welcomeStarted = false;
    const cleanup = startLocalFirstListInitialization(
      async () => { await preferencesReady; return paths; },
      () => { welcomeStarted = true; return new Promise<void>(() => {}); },
      async folders => {
        await refreshMetadataIdentities([], folders);
        published.push(readFolderExpandedState(localStorage.localStorage));
      },
      error => { throw error; },
    );
    assert.deepEqual(published, []);
    storage.set("folderExpanded", JSON.stringify({ "root:lyra": true, ...expected }));
    storage.set("folderOrder", JSON.stringify({ "": [...paths].reverse() }));
    releasePreferences();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(published, [], "the explorer must stay unpublished during identity verification");
    assert.equal(welcomeStarted, false, "the second listing must wait for the verified first state");
    releaseIdentities();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(published, [{ "root:lyra": true, ...expected }]);
    assert.equal(welcomeStarted, true);
    cleanup();
  }
});
