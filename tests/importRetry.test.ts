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

// P5a: fallo → reintento inmediato pasa (no es duplicado).
test("M2-5a failed batch allows immediate retry", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});
  let calls = 0;
  const mockInvoke = async (cmd: string) => {
    if (cmd === "import_external_files") {
      calls++;
      if (calls === 1) throw new Error("backend down");
      return { imported: [{ original_path: "/x/retry.txt", file_name: "retry.txt", size: 10 }], errors: [] };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = { invoke: mockInvoke };
  const first = await enqueueExternalFileImport(["/x/retry.txt"]).promise;
  assert.equal(first.status, "failed");
  const second = await enqueueExternalFileImport(["/x/retry.txt"]).promise;
  assert.equal(second.status, "completed", "failed path must be retryable immediately");
  assert.equal(calls, 2);
});

// P5b: parcial → reintento de la ruta fallida pasa.
test("M2-5b partial batch allows retry of failed path only", async () => {
  __resetImportQueueForTests();
  setupMockEnvironment();
  useToastStore.getState().clearToasts();
  fileStore.getState().setFiles([]);
  fileStore.getState().setSelectedFile({ name: "otra.txt", content: "otra" });
  registerNavigator(() => {});
  let calls = 0;
  const mockInvoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      calls++;
      const paths = (args?.paths ?? []) as string[];
      if (calls === 1) {
        return {
          imported: paths.filter((p) => p.endsWith("ok.txt")).map((p) => ({ original_path: p, file_name: "ok.txt", size: 10 })),
          errors: paths.filter((p) => p.endsWith("bad.txt")).map((p) => ({ path: p, error: "binario" })),
        };
      }
      return { imported: paths.map((p) => ({ original_path: p, file_name: p.split("/").pop(), size: 10 })), errors: [] };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = { invoke: mockInvoke };
  const first = await enqueueExternalFileImport(["/x/ok.txt", "/x/bad.txt"]).promise;
  assert.equal(first.status, "partial");
  // Reintent de la ruta OK dentro de la ventana → duplicado.
  const againOk = await enqueueExternalFileImport(["/x/ok.txt"]).promise;
  assert.equal(againOk.status, "rejected");
  // Reintento de la fallida → pasa.
  const retryBad = await enqueueExternalFileImport(["/x/bad.txt"]).promise;
  assert.equal(retryBad.status, "completed");
});
