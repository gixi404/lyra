import test from "node:test";
import assert from "node:assert/strict";
import { searchStore, hydrateSortOptionFromStorage } from "../src/store/searchStore.ts";
import { initPersistentPreferences } from "../src/utils/persistentPreferences.ts";

test("AUD2-009 restores disk-backed sort without writing a default", () => {
  const values = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  try {
    values.set("sortOption", "az");
    hydrateSortOptionFromStorage();
    assert.equal(searchStore.getState().sortOption, "az");
    assert.equal(values.get("sortOption"), "az");
    values.set("sortOption", "mtime");
    hydrateSortOptionFromStorage();
    assert.equal(searchStore.getState().sortOption, "mtime");
    values.set("sortOption", "invalid");
    hydrateSortOptionFromStorage();
    assert.equal(searchStore.getState().sortOption, "mtime");
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
});

test("AUD2-009 restores sort from preferences IPC before search store hydration", async () => {
  const local = new Map<string, string>([["sortOption", "mtime"]]);
  let disk = JSON.stringify({ sortOption: "az", paper: [], lyra_theme_migrated_v2: true, initialized: true });
  const commands: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value); },
      removeItem: (key: string) => { local.delete(key); },
    },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { path?: string; paths?: string[] } | Uint8Array) => {
        commands.push(command);
        if (command === "plugin:path|join") return (args as { paths: string[] }).paths?.join("/");
        if (command === "plugin:fs|exists") return (args as { path: string }).path === "lyra/.preferences.json";
        if (command === "plugin:fs|read_text_file") return new TextEncoder().encode(disk);
        if (command === "plugin:fs|mkdir") return undefined;
        if (command === "plugin:fs|write_text_file") { disk = new TextDecoder().decode(args as Uint8Array); return undefined; }
        throw new Error(`unexpected IPC ${command}`);
      },
    },
  };
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: (globalThis as unknown as { window: { localStorage: unknown } }).window.localStorage });
  await initPersistentPreferences();
  assert.equal(local.get("sortOption"), "az", JSON.stringify(commands));
  hydrateSortOptionFromStorage();
  assert.equal(searchStore.getState().sortOption, "az");
  searchStore.getState().setSortOption("mtime");
  assert.equal(searchStore.getState().sortOption, "mtime");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(JSON.parse(disk).sortOption, "mtime");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousStorage });
});
