import { test } from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";
import { useToastStore } from "../src/store/toastStore.ts";
import { registerNavigator } from "../src/utils/navigation.ts";
import {
  enqueueExternalFileImport,
  __resetImportQueueForTests,
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

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// M2-1 slow-batch dedup: second same-path job enqueued while first is active
// and executed AFTER >1s since first START, but within 1s of first completion,
// must be rejected as duplicate (not create a " (1)" copy).
test("M2-1b slow first batch: duplicate within completion window is rejected", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});

  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  const mockInvoke = async (cmd: string) => {
    if (cmd === "import_external_files") {
      calls++;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = () => resolve(); });
        return { imported: [{ original_path: "/x/slow.txt", file_name: "slow.txt", size: 10 }], errors: [] };
      }
      return { imported: [{ original_path: "/x/slow.txt", file_name: "slow (1).txt", size: 10 }], errors: [] };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  const first = enqueueExternalFileImport(["/x/slow.txt"]);
  const second = enqueueExternalFileImport(["/x/slow.txt"]);
  await delay(1100); // first has been RUNNING >1s (old code would have expired dedup).
  releaseFirst?.();
  const [o1, o2] = await Promise.all([first.promise, second.promise]);
  assert.equal(o1.status, "completed");
  assert.equal(o2.status, "rejected", `second must dedupe, got ${JSON.stringify(o2)}`);
  assert.equal(o2.reason, "duplicate");
  assert.equal(calls, 1, "backend must be called exactly once");
});

// A1 behavioral: empty file navigates, read failure does not.
test("A1-b empty file is ok:true and navigates; read error is ok:false without navigation", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  // Empty file: read returns empty bytes.
  const mockEmpty = async (cmd: string) => {
    if (cmd === "import_external_files") return { imported: [{ original_path: "/x/vacio.txt", file_name: "vacio.txt", size: 0 }], errors: [] };
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = { invoke: mockEmpty };
  let navigated = "";
  registerNavigator((p) => { navigated = p; });
  const h1 = enqueueExternalFileImport(["/x/vacio.txt"]);
  const o1 = await h1.promise;
  assert.equal(o1.status, "completed");
  assert.equal(navigated, "/file", "empty file must navigate (legit empty, not error)");
  assert.equal(fileStore.getState().selectedFile.content, "");

  // Read failure: plugin throws.
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  navigated = "";
  const mockFail = async (cmd: string) => {
    if (cmd === "import_external_files") return { imported: [{ original_path: "/x/roto.txt", file_name: "roto.txt", size: 10 }], errors: [] };
    if (cmd === "plugin:fs|read_text_file") throw new Error("EACCES: Permission denied");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = { invoke: mockFail };
  const h2 = enqueueExternalFileImport(["/x/roto.txt"]);
  const o2 = await h2.promise;
  assert.equal(o2.imported.length, 1, "import completed");
  assert.ok(o2.openingError, "openingError must be present");
  assert.equal(navigated, "", "must not navigate on read failure");
  assert.equal(fileStore.getState().selectedFile.name, "otra.txt");
});
