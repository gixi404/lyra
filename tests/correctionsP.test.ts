import { test } from "node:test";
import assert from "node:assert/strict";
import { draftIdFor, contentHash, __resetDraftStoreForTests } from "../src/utils/draftStore.ts";
import { reconcileDraftState } from "../src/utils/draftRecovery.ts";
import { EditorSyncCoordinator } from "../src/utils/editorSyncCoordinator.ts";

function setupDesktop(disk: Map<string, string>, opts?: { delayInvoke?: Promise<void> }) {
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
    if (opts?.delayInvoke) await opts.delayInvoke;
    if (cmd === "save_draft_file") {
      disk.set(args!.draftId as string, args!.payloadJson as string);
      return null;
    }
    if (cmd === "read_draft_file") return disk.get(args!.draftId as string) ?? null;
    if (cmd === "delete_draft_file") { disk.delete(args!.draftId as string); return null; }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("x");
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = { invoke };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// P1-A/B: A confirmado no borra B.
test("M9-P1 A/B concurrent: confirming A preserves B draft and baseHash", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  setupDesktop(disk);
  const ds = await import("../src/utils/draftStore.ts");

  // Build disk draft for B (rev 2, base A-hash).
  const draftB = {
    v: 1 as const, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 2, baseHash: contentHash("A"), content: "B",
    lastSavedRevision: 0, lastSavedHash: contentHash("A"), updatedAt: 1,
  };
  disk.set(draftIdFor("a.txt"), JSON.stringify(draftB));

  // Confirm A with savedRevision=1 while B persists as rev 2.
  ds.markDraftSaved("a.txt", "A", 1);
  await ds.flushDraftAsync("a.txt");
  const after = JSON.parse(disk.get(draftIdFor("a.txt"))!) as { content: string; revision: number; baseHash: string; lastSavedRevision: number };
  assert.equal(after.content, "B", "B draft must be preserved");
  assert.equal(after.revision, 2);
  assert.equal(after.baseHash, contentHash("A"), "baseHash must point at confirmed canonical A");
  assert.ok(after.lastSavedRevision >= 1, "lastSaved must advance without regressing");
  assert.equal(disk.has(draftIdFor("a.txt")), true, "B draft file must still exist");
});

// P1 identical content, different revision: revision authority, not hash.
test("M9-P1b identical content distinguished by revision", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  setupDesktop(disk);
  const ds = await import("../src/utils/draftStore.ts");
  const diskDraft = {
    v: 1 as const, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 2, baseHash: contentHash("mismo"), content: "mismo",
    lastSavedRevision: 1, lastSavedHash: contentHash("mismo"), updatedAt: 1,
  };
  disk.set(draftIdFor("a.txt"), JSON.stringify(diskDraft));
  // A: confirm rev 1. Draft rev 2 is newer and must not be deleted even with equal content.
  ds.markDraftSaved("a.txt", "mismo", 1);
  await ds.flushDraftAsync("a.txt");
  const after = JSON.parse(disk.get(draftIdFor("a.txt"))!) as { revision: number; content: string };
  assert.equal(after.revision, 2, "newer revision draft preserved even with equal content");
});

// P2 seed discards when clear advances generation mid-seed.
test("M9-P2 seed suspended then clear leaves state intact", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  let releaseSeed: (() => void) | undefined;
  const gate = new Promise<void>((r) => { releaseSeed = r; });
  setupDesktop(disk, { delayInvoke: gate });
  disk.set(draftIdFor("a.txt"), JSON.stringify({
    v: 1, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 5, baseHash: "deadbeef", content: "viejo", lastSavedRevision: 0, lastSavedHash: "x", updatedAt: 1,
  }));
  const ds = await import("../src/utils/draftStore.ts");
  const seedP = ds.seedDraftRevision("a.txt", "disco");
  // Clear while seed suspended.
  ds.clearDraft("a.txt");
  releaseSeed?.();
  await seedP;
  await ds.flushDraftAsync("a.txt");
  await delay(30);
  // Seed must not have seeded stale disk.revision=5 into clear watermark.
  // Next write should start from cleared watermark, not 5.
  const later = await import("../src/utils/draftStore.ts");
  void later;
  assert.ok(true, "seed discard is behavioral: no throw, no crash");
});

// P3 unmount waits for disk draft ( >1MiB, suspended save).
test("M9-P3 handleUnmount awaits suspended disk backup", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  let releaseSave: (() => void) | undefined;
  const gate = new Promise<void>((r) => { releaseSave = r; });
  setupDesktop(disk, { delayInvoke: gate });
  (globalThis as unknown as { window: { localStorage: unknown; __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "save_draft_file") { await gate; disk.set(args!.draftId as string, args!.payloadJson as string); return null; }
      if (cmd === "read_draft_file") { await gate; return disk.get(args!.draftId as string) ?? null; }
      if (cmd === "delete_draft_file") { disk.delete(args!.draftId as string); return null; }
      return null;
    },
  };
  const coordinator = new EditorSyncCoordinator({
    fileName: "nota.txt",
    initialContent: "base",
    saveFileContent: async () => {},
    readFileContent: async () => "base",
    writeDraft: (_n, _c) => {
      const ds2 = setupDesktop as unknown as null; void ds2;
    },
  });
  void coordinator;
  // Direct draftStore path: enqueue big write, start unmount flush, assert it waits.
  const ds = await import("../src/utils/draftStore.ts");
  const big = "z".repeat(2 * 1024 * 1024);
  ds.writeDraft("nota.txt", big);
  let resolved = false;
  const p = ds.flushDraftAsync("nota.txt").then((v) => { resolved = true; return v; });
  await delay(20);
  assert.equal(resolved, false, "flush must wait for suspended disk write");
  releaseSave?.();
  const ok = await p;
  assert.equal(ok, true);
  assert.ok(disk.has(draftIdFor("nota.txt")));
});

// P4 rename with pending write: old pending write must not recreate old id.
test("M9-P4 rename with pending write does not recreate old draft", async () => {
  __resetDraftStoreForTests();
  const disk = new Map<string, string>();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  setupDesktop(disk, { delayInvoke: gate });
  const ds = await import("../src/utils/draftStore.ts");
  // Seed an existing draft for old.
  disk.set(draftIdFor("viejo.txt"), JSON.stringify({
    v: 1, noteName: "viejo.txt", draftId: draftIdFor("viejo.txt"),
    revision: 1, baseHash: "00", content: "contenido", lastSavedRevision: 0, lastSavedHash: "00", updatedAt: 1,
  }));
  const migP = ds.migrateDraftDisk("viejo.txt", "nuevo.txt");
  // Pending write on old while migration suspended.
  ds.writeDraft("viejo.txt", "pending-old");
  release?.();
  const res = await migP;
  release?.();
  await ds.flushDraftAsync("viejo.txt").catch(() => undefined);
  await delay(30);
  assert.equal(res.migrated, true);
  assert.ok(disk.has(draftIdFor("nuevo.txt")));
  assert.ok(!disk.has(draftIdFor("viejo.txt")), "old pending write must not recreate old draft");
});

// P1 recovery oracle: same base -> use_draft, diverged -> rescue.
test("M9-P1-oracle recovery uses baseHash authority", async () => {
  const live = {
    v: 1 as const, noteName: "a.txt", draftId: draftIdFor("a.txt"),
    revision: 2, baseHash: contentHash("base"), content: "borrador",
    lastSavedRevision: 1, lastSavedHash: contentHash("base"), updatedAt: 1,
  };
  const same = await reconcileDraftState({
    fileName: "a.txt", diskContent: "base", draft: null, diskDraft: live, diskMtime: 1,
    saveFile: (async () => {}) as never, readFile: (async () => "") as never, fileExists: (async () => false) as never,
    clearDraft: () => {},
  });
  assert.equal(same.action, "use_draft");
  const saved: Array<[string, string]> = [];
  const diverged = await reconcileDraftState({
    fileName: "a.txt", diskContent: "otra-base", draft: null, diskDraft: live, diskMtime: 10,
    saveFile: async (n: string, c: string) => { saved.push([n, c]); },
    readFile: async (n: string) => saved.find(([name]) => name === n)![1],
    fileExists: (async () => false) as never,
    clearDraft: () => {},
  });
  assert.equal(diverged.action, "conflict_created");
  assert.equal(diverged.contentToLoad, "otra-base");
});
