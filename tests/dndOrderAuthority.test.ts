import test from "node:test";
import assert from "node:assert/strict";
import {
  bindMetadata,
  metadataMatches,
  metadataOrderValid,
} from "../src/utils/metadataIdentity.ts";

// Reproduce el entorno mínimo de identidad (Tauri mock) sin el bypass de desarrollo.
function fixture(identities: Map<string, string>) {
  const storage = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => storage.clear(),
      get length() { return storage.size; },
      key: () => null,
    },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { kind: string; path: string }) => {
        if (command === "metadata_identity") return identities.get(`${args.kind}:${args.path}`) ?? null;
        return undefined;
      },
    },
  };
  return { storage };
}

test("metadataOrderValid conserva archivos sin vínculo mientras metadataMatches los descarta", async () => {
  const identities = new Map<string, string>();
  fixture(identities);
  // Un archivo legítimo sin vínculo de identidad no evidencia reemplazo: su
  // posición de orden debe conservarse, aunque no tenga personalización asociada.
  assert.equal(metadataOrderValid("file", "plain.md"), true, "sin vínculo: conservar posición");
  assert.equal(metadataMatches("file", "plain.md"), false, "sin vínculo: sin personalización");

  // Una carpeta sin vínculo también conserva su posición.
  assert.equal(metadataOrderValid("folder", "Work"), true);
  assert.equal(metadataMatches("folder", "Work"), false);
});

test("metadataOrderValid concuerda con metadataMatches para un archivo vinculado", async () => {
  const identities = new Map<string, string>([["file:bound.md", "id-a"]]);
  fixture(identities);
  assert.equal(await bindMetadata("file", "bound.md"), true);
  assert.equal(metadataOrderValid("file", "bound.md"), true);
  assert.equal(metadataMatches("file", "bound.md"), true);
});
