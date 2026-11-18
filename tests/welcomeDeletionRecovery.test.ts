import test from "node:test";
import assert from "node:assert/strict";
import { ensureWelcomeFileState, WELCOME_FILE_NAME } from "../src/utils/welcome.ts";

test("AUD2-010: deleted welcome stays dismissed after restart and manual restoration remains visible", async () => {
  const local = new Map<string, string>();
  let present = false;
  let created = 0;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value); },
      removeItem: (key: string) => { local.delete(key); },
    },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { path?: string; paths?: string[] }) => {
        if (command === "plugin:fs|exists") return args.path === "lyra" || present;
        if (command === "plugin:fs|read_dir") return present ? [{ name: WELCOME_FILE_NAME, isFile: true, isDirectory: false }] : [];
        if (command === "plugin:path|join") return args.paths?.join("/");
        if (command === "was_welcome_deleted") return true;
        if (command === "create_internal_welcome") { created++; present = true; return true; }
        if (command === "plugin:fs|write_text_file") return undefined;
        throw new Error(`unexpected IPC ${command}`);
      },
    },
  };
  const afterCrash = await ensureWelcomeFileState();
  assert.equal(afterCrash.created, false);
  assert.equal(created, 0);
  assert.equal(local.get("welcome_dismissed"), "true");
  present = true;
  const restored = await ensureWelcomeFileState();
  assert.equal(restored.activeWelcome, WELCOME_FILE_NAME);
  assert.equal(created, 0);
});
