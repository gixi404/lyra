import { test } from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";
import { useToastStore } from "../src/store/toastStore.ts";
import { registerNavigator } from "../src/utils/navigation.ts";
import {
  enqueueExternalFileImport,
  handleExternalFileImport,
  subscribeImportJob,
  __resetImportQueueForTests,
  __getImportQueueDepthForTests,
} from "../src/utils/fileImporter.ts";

function setupMockEnvironment() {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    },
    sessionStorage: {
      getItem: (k: string) => store.get(`session:${k}`) ?? null,
      setItem: (k: string, v: string) => store.set(`session:${k}`, String(v)),
      removeItem: (k: string) => store.delete(`session:${k}`),
    },
    matchMedia: () => ({ matches: false }),
    __TAURI_INTERNALS__: {},
  };
  return store;
}

function installImportMock(
  handler: (paths: string[]) => Promise<{ imported: unknown[]; errors: unknown[] }> | { imported: unknown[]; errors: unknown[] },
  hooks?: { onInvoke?: (paths: string[]) => void; readFails?: boolean },
): void {
  const mockInvoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      const paths = (args?.paths ?? []) as string[];
      hooks?.onInvoke?.(paths);
      return handler(paths);
    }
    if (cmd === "plugin:fs|read_text_file") {
      if (hooks?.readFails) throw new Error("EACCES: Permission denied");
      return new TextEncoder().encode("contenido");
    }
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// M2-1: Two or more concurrent batches processed exactly once in FIFO order.
test("M2-1 FIFO batches processed exactly once in order", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  let navigatedTo = "";
  registerNavigator((p) => { navigatedTo = p; });

  const order: string[] = [];
  const resolvers: Array<() => void> = [];
  installImportMock(
    (paths) => new Promise((resolve) => {
      order.push(paths[0]);
      resolvers.push(() => resolve({ imported: [{ original_path: paths[0], file_name: paths[0].split("/").pop(), size: 10 }], errors: [] }));
    }),
  );

  const a = enqueueExternalFileImport(["/x/a.txt"]);
  const b = enqueueExternalFileImport(["/x/b.txt"]);
  const c = enqueueExternalFileImport(["/x/c.txt"]);
  await delay(20);
  assert.equal(order.length, 1, "worker must be processing A only");
  assert.deepEqual(order, ["/x/a.txt"]);

  resolvers[0]();
  await delay(20);
  assert.deepEqual(order, ["/x/a.txt", "/x/b.txt"], "B starts after A resolves");
  resolvers[1]();
  await delay(20);
  assert.deepEqual(order, ["/x/a.txt", "/x/b.txt", "/x/c.txt"], "C starts after B");
  resolvers[2]();

  const [oa, ob, oc] = await Promise.all([a.promise, b.promise, c.promise]);
  assert.equal(oa.status, "completed");
  assert.equal(ob.status, "completed");
  assert.equal(oc.status, "completed");
  assert.equal(order.length, 3, "each batch exactly once");
  assert.equal(navigatedTo, "/file");
});

// M2-2: Partial result with successful and failed imports.
test("M2-2 partial outcome counts only confirmed imports", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});

  installImportMock((paths) => ({
    imported: [{ original_path: paths[0], file_name: "ok.txt", size: 10 }],
    errors: [{ path: paths[1], error: "El formato '.exe' no es compatible" }],
  }));

  const h = enqueueExternalFileImport(["/x/ok.txt", "/x/bad.exe"]);
  const outcome = await h.promise;
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.imported.length, 1);
  assert.equal(outcome.errors.length, 1);
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.some((t) => t.type === "error" && t.msg.includes(".exe")), true);
  assert.equal(toasts.some((t) => t.type === "success"), true, "success only for confirmed import");
});

// M2-3: Full queue rejects explicitly and notifies.
test("M2-3 queue full rejects explicitly and notifies", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});

  let releaseActive: (() => void) | undefined;
  installImportMock((paths) => new Promise((resolve) => {
    if (paths[0].endsWith("active.txt")) {
      releaseActive = () => resolve({ imported: [{ original_path: paths[0], file_name: "active.txt", size: 10 }], errors: [] });
    } else {
      resolve({ imported: [{ original_path: paths[0], file_name: paths[0].split("/").pop(), size: 10 }], errors: [] });
    }
  }));

  const active = enqueueExternalFileImport(["/x/active.txt"]);
  const queued: ReturnType<typeof enqueueExternalFileImport>[] = [];
  for (let i = 0; i < 32; i++) queued.push(enqueueExternalFileImport([`/x/q${i}.txt`]));
  await delay(10);
  assert.equal(__getImportQueueDepthForTests(), 32);

  const rejected = enqueueExternalFileImport(["/x/overflow.txt"]);
  const outcome = await rejected.promise;
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason, "queue_full");
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.some((t) => t.type === "error" && t.msg.includes("Cola de importación llena")), true);

  releaseActive?.();
  await active.promise;
  await Promise.all(queued.map((q) => q.promise));
  assert.equal(__getImportQueueDepthForTests(), 0);
});

// M2-4: Duplicate paths without losing other files.
test("M2-4 dedup drops only duplicates within window, keeps fresh files", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});

  const seen: string[][] = [];
  installImportMock((paths) => {
    seen.push([...paths]);
    return { imported: paths.map((p) => ({ original_path: p, file_name: p.split("/").pop(), size: 10 })), errors: [] };
  });

  const first = await enqueueExternalFileImport(["/x/dup.txt"]).promise;
  assert.equal(first.status, "completed");
  // Same path again within window -> rejected, no backend call.
  const dup = await enqueueExternalFileImport(["/x/dup.txt"]).promise;
  assert.equal(dup.status, "rejected");
  assert.equal(dup.reason, "duplicate");
  assert.equal(seen.length, 1);
  // Mixed batch: dup + fresh -> fresh still imported, no loss.
  const mixed = await enqueueExternalFileImport(["/x/dup.txt", "/x/fresh.txt"]).promise;
  assert.equal(mixed.status, "completed");
  assert.equal(mixed.imported.length, 1);
  assert.equal(mixed.imported[0].file_name, "fresh.txt");
});

// M2-5: Unmount of starter does not affect delivery.
test("M2-5 outcome delivered via promise/subscribe after starter unmounts", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});

  let releaseActive: (() => void) | undefined;
  installImportMock((paths) => new Promise((resolve) => {
    if (paths[0].endsWith("slow.txt")) {
      releaseActive = () => resolve({ imported: [{ original_path: paths[0], file_name: "slow.txt", size: 10 }], errors: [] });
    } else {
      resolve({ imported: [{ original_path: paths[0], file_name: "fast.txt", size: 10 }], errors: [] });
    }
  }));

  const slow = enqueueExternalFileImport(["/x/slow.txt"]);
  let viaSubscribe: unknown = undefined;
  const unsub = subscribeImportJob(slow.jobId, (o) => { viaSubscribe = o; });
  // Simulate starter unmount: drop local references, keep only the promise.
  const starterGone = undefined;
  void starterGone;
  // Unsubscribe is a separate path: a component that unsubscribes still gets promise.
  // We keep subscription here to prove delivery, promise is the primary channel.
  releaseActive?.();
  const viaPromise = await slow.promise;
  assert.equal(viaPromise.status, "completed");
  assert.equal(viaSubscribe !== undefined, true);
  unsub();
});

// M2-6: Read failure after import does not navigate (A1 preserved).
test("M2-6 read failure after import: no navigation to empty editor", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  let navigatedTo = "";
  registerNavigator((p) => { navigatedTo = p; });

  installImportMock(
    (paths) => ({ imported: [{ original_path: paths[0], file_name: "leeme.txt", size: 10 }], errors: [] }),
    { readFails: true },
  );

  const outcome = await enqueueExternalFileImport(["/x/leeme.txt"]).promise;
  assert.equal(outcome.imported.length, 1, "import itself completed");
  assert.equal(outcome.openingError !== undefined, true);
  assert.equal(navigatedTo, "", "must not navigate on read failure");
  assert.equal(fileStore.getState().selectedFile.name, "otra.txt", "selection unchanged");
  assert.equal(fileStore.getState().files.includes("leeme.txt"), true, "file stays in list for retry");
});

// M2-7: No duplicate processing under rapid fire.
test("M2-7 rapid fire: each unique path invokes backend exactly once", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});

  const counts = new Map<string, number>();
  installImportMock((paths) => {
    for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
    return { imported: paths.map((p) => ({ original_path: p, file_name: p.split("/").pop(), size: 10 })), errors: [] };
  });

  // Fire 5 jobs without awaiting; duplicates in 2nd/3rd.
  const jobs = [
    enqueueExternalFileImport(["/x/one.txt"]),
    enqueueExternalFileImport(["/x/one.txt"]),
    enqueueExternalFileImport(["/x/two.txt"]),
    enqueueExternalFileImport(["/x/two.txt", "/x/one.txt"]),
    enqueueExternalFileImport(["/x/three.txt"]),
  ];
  const outcomes = await Promise.all(jobs.map((j) => j.promise));
  assert.equal(counts.get("/x/one.txt"), 1, "one.txt processed once");
  assert.equal(counts.get("/x/two.txt"), 1, "two.txt processed once");
  assert.equal(counts.get("/x/three.txt"), 1, "three.txt processed once");
  // Legacy wrapper still resolves boolean consistently.
  const legacy = await handleExternalFileImport(["/x/one.txt"]);
  assert.equal(legacy, false, "legacy second call within window is dup");
  assert.equal(outcomes.filter((o) => o.status === "rejected").length >= 1, true);
});
