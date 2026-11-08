import { test } from "node:test";
import assert from "node:assert/strict";
import { draftIdFor, contentHash, __resetDraftStoreForTests } from "../src/utils/draftStore.ts";
import { reconcileDraftState } from "../src/utils/draftRecovery.ts";

test("M9-T1 stable identity distinguishes homonyms, stable per path", () => {
  const a = draftIdFor("sub/a.txt");
  const b = draftIdFor("a.txt");
  assert.notEqual(a, b, "homonyms in different folders must differ");
  assert.equal(draftIdFor("sub/a.txt"), a, "same path same id");
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("M9-T2 quota error does not throw", async () => {
  __resetDraftStoreForTests();
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k.startsWith("lyra-draft") && v.length > 50) throw new DOMException("QuotaExceededError", "QuotaExceededError");
        store.set(k, String(v));
      },
      removeItem: (k: string) => store.delete(k),
    },
  };
  const ds = await import("../src/utils/draftStore.ts");
  ds.writeDraft("nota.txt", "x".repeat(100));
  assert.ok(["idle", "protected_ls", "protected_disk", "pending", "unprotected"].includes(ds.getDraftProtection()));
  await ds.flushDraftAsync("nota.txt");
});

test("M9-T3 obsolete disk draft after canonical save is cleared", async () => {
  const diskDraft = {
    v: 1 as const, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 3, baseHash: contentHash("viejo"), content: "borrador",
    lastSavedRevision: 3, lastSavedHash: contentHash("nuevo"), updatedAt: 1000,
  };
  let cleared = false;
  const res = await reconcileDraftState({
    fileName: "a.txt", diskContent: "nuevo", draft: null, diskDraft, diskMtime: 2000,
    saveFile: (async () => {}) as never, readFile: (async () => "") as never, fileExists: (async () => false) as never,
    clearDraft: () => { cleared = true; },
  });
  assert.equal(res.action, "use_disk");
  assert.equal(res.contentToLoad, "nuevo");
  assert.equal(cleared, true);
});

test("M9-T4 stale draft vs newer canonical creates rescue, never overwrites", async () => {
  const diskDraft = {
    v: 1 as const, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 2, baseHash: contentHash("base-vieja"), content: "borrador-viejo",
    lastSavedRevision: 1, lastSavedHash: contentHash("base-vieja"), updatedAt: 1000,
  };
  const saved: Array<[string, string]> = [];
  const res = await reconcileDraftState({
    fileName: "a.txt", diskContent: "canonico-nuevo", draft: null, diskDraft, diskMtime: 2000,
    saveFile: async (n: string, c: string) => { saved.push([n, c]); },
    readFile: async (n: string) => saved.find(([name]) => name === n)![1],
    fileExists: (async () => false) as never,
    clearDraft: () => {},
  });
  assert.equal(res.action, "conflict_created");
  assert.equal(res.contentToLoad, "canonico-nuevo");
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1], "borrador-viejo");
});

test("M9-T5 live revision on same base loads draft without rescue", async () => {
  const diskDraft = {
    v: 1 as const, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 2, baseHash: contentHash("base"), content: "borrador-vivo",
    lastSavedRevision: 1, lastSavedHash: contentHash("base"), updatedAt: 1000,
  };
  const res = await reconcileDraftState({
    fileName: "a.txt", diskContent: "base", draft: null, diskDraft, diskMtime: 2000,
    saveFile: (async () => {}) as never, readFile: (async () => "") as never, fileExists: (async () => false) as never,
    clearDraft: () => { throw new Error("must not clear live draft"); },
  });
  assert.equal(res.action, "use_draft");
  assert.equal(res.contentToLoad, "borrador-vivo");
});

test("M9-T6 missing draft conservatively loads disk", async () => {
  const res = await reconcileDraftState({
    fileName: "a.txt", diskContent: "disco", draft: null, diskDraft: null, diskMtime: null,
    saveFile: (async () => {}) as never, readFile: (async () => "") as never, fileExists: (async () => false) as never,
    clearDraft: () => {},
  });
  assert.equal(res.action, "use_disk");
  assert.equal(res.contentToLoad, "disco");
});

test("M9-T7 rapid edits all serialize through the queue", async () => {
  __resetDraftStoreForTests();
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
    },
  };
  const ds = await import("../src/utils/draftStore.ts");
  for (let i = 0; i < 20; i++) ds.writeDraft("rapida.txt", `v${i}`);
  await ds.flushDraftAsync("rapida.txt");
  assert.ok(["protected_ls", "protected_disk", "idle"].includes(ds.getDraftProtection()));
});

function setupDesktop(disk: Map<string, string>, opts?: { delayRead?: number; failSave?: boolean }) {
  const lsStore = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => lsStore.get(k) ?? null,
      setItem: (k: string, v: string) => lsStore.set(k, String(v)),
      removeItem: (k: string) => lsStore.delete(k),
    },
    __TAURI_INTERNALS__: {},
  };
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "save_draft_file") {
      if (opts?.failSave) throw new Error("disk full");
      disk.set(args!.draftId as string, args!.payloadJson as string);
      return null;
    }
    if (cmd === "read_draft_file") {
      if (opts?.delayRead) await new Promise<void>((r) => setTimeout(r, opts.delayRead));
      return disk.get(args!.draftId as string) ?? null;
    }
    if (cmd === "delete_draft_file") {
      disk.delete(args!.draftId as string);
      return null;
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("x");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = { invoke };
  return lsStore;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// M9-1: >1MiB draft migrates to new identity, original removed. Failure keeps original.
test("M9-T8 rename migration moves >1MiB disk draft", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  const ds = await import("../src/utils/draftStore.ts");
  setupDesktop(disk);
  const big = "x".repeat(2 * 1024 * 1024);
  ds.writeDraft("viejo.txt", big);
  await ds.flushDraftAsync("viejo.txt");
  assert.ok(disk.has(draftIdFor("viejo.txt")), "disk fallback must exist for >1MiB");
  const res = await ds.migrateDraftDisk("viejo.txt", "nuevo.txt");
  assert.equal(res.migrated, true);
  assert.ok(disk.has(draftIdFor("nuevo.txt")));
  assert.ok(!disk.has(draftIdFor("viejo.txt")), "old must be deleted after successful migration");
});

test("M9-T9 migration failure keeps original", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  const ds = await import("../src/utils/draftStore.ts");
  setupDesktop(disk, { failSave: true });
  // Seed an original by direct map write (writeDraft would also fail).
  disk.set(draftIdFor("viejo.txt"), JSON.stringify({ v: 1, noteName: "viejo.txt", draftId: draftIdFor("viejo.txt"), revision: 1, baseHash: "00", content: "hello", lastSavedRevision: 0, lastSavedHash: "00", updatedAt: 1 }));
  const res = await ds.migrateDraftDisk("viejo.txt", "nuevo.txt");
  assert.equal(res.migrated, false);
  assert.equal(res.keptOriginal, true);
  assert.ok(disk.has(draftIdFor("viejo.txt")), "original must not be deleted on failure");
  assert.ok(!disk.has(draftIdFor("nuevo.txt")));
});

// M9-2: write suspended in seed, then clear -> must not recreate.
test("M9-T10 suspended-seed write does not resurrect after clear", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  const ds = await import("../src/utils/draftStore.ts");
  setupDesktop(disk, { delayRead: 50 });
  ds.writeDraft("nota.txt", "pendiente".repeat(1000)); // > cap? short but keep LS small; force disk by size
  // Force over-cap path by writing large content (disk).
  __resetDraftStoreForTests();
  setupDesktop(disk, { delayRead: 50 });
  const big = "y".repeat(2 * 1024 * 1024);
  ds.writeDraft("nota.txt", big);
  ds.clearDraft("nota.txt"); // enqueue delete; generation barrier must discard the pending write.
  await ds.flushDraftAsync("nota.txt");
  await delay(80);
  assert.ok(!disk.has(draftIdFor("nota.txt")), "late write must not recreate draft after clear");
});

// M9-4/5: restart between canonical and state -> obsolete draft cleared.
test("M9-T11 restart with advanced state recovers conservatively", async () => {
  const { reconcileDraftState } = await import("../src/utils/draftRecovery.ts");
  const { contentHash } = await import("../src/utils/draftStore.ts");
  const diskDraft = {
    v: 1 as const, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 2, baseHash: contentHash("base"), content: "guardado",
    lastSavedRevision: 2, lastSavedHash: contentHash("guardado"), updatedAt: 1,
  };
  let cleared = false;
  const res = await reconcileDraftState({
    fileName: "a.txt", diskContent: "guardado", draft: null, diskDraft, diskMtime: 10,
    saveFile: (async () => {}) as never, readFile: (async () => "") as never, fileExists: (async () => false) as never,
    clearDraft: () => { cleared = true; },
  });
  assert.equal(res.action, "use_disk");
  assert.equal(cleared, true);
});

test("M9-T12 corrupt disk draft is ignored without throwing", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  disk.set(draftIdFor("x.txt"), "no-json-corrupto");
  const ds = await import("../src/utils/draftStore.ts");
  setupDesktop(disk);
  const parsed = await ds.readDraftDisk("x.txt");
  assert.equal(parsed, null, "corrupt must parse to null conservatively");
  assert.ok(disk.has(draftIdFor("x.txt")), "corrupt file must be kept for inspection");
});

// M9-6 pagehide: source must register and unregister the same named handler.
test("M9-T13 pagehide handler is named and symmetric", async () => {
  const { readFileSync } = await import("node:fs");
  const fc = readFileSync(new URL("../src/pages/FileContent.tsx", import.meta.url), "utf8");
  const addIdx = fc.indexOf('addEventListener("pagehide"');
  const remIdx = fc.indexOf('removeEventListener("pagehide"');
  assert.ok(addIdx !== -1 && remIdx !== -1);
  const addSnippet = fc.slice(addIdx, addIdx + 60);
  const remSnippet = fc.slice(remIdx, remIdx + 60);
  assert.ok(addSnippet.includes("flushOnPagehide") || addSnippet.includes("flushOnLifecycleChange"), "must use named handler for pagehide");
  assert.ok(remSnippet.includes("flushOnPagehide") || remSnippet.includes("flushOnLifecycleChange"), "remove must use the same named handler");
  assert.ok(!fc.includes('removeEventListener("pagehide", () =>'), "must not use anonymous remove");
});
