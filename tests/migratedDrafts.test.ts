import test from "node:test";
import assert from "node:assert/strict";
import { rescueMigratedDrafts } from "../src/utils/migratedDrafts.ts";

function fixture() {
  const drafts = new Map<string, string>();
  const notes = new Map<string, string>();
  const storage = {
    getItem: (key: string) => drafts.get(key) ?? null,
    removeItem: (key: string) => { drafts.delete(key); },
  };
  const files = {
    createExclusive: async (name: string, content: string) => {
      if (notes.has(name)) throw new Error("AlreadyExists");
      notes.set(name, content);
    },
    read: async (name: string) => notes.get(name) ?? "",
    exists: async (name: string) => notes.has(name),
  };
  return { drafts, notes, storage, files };
}

test("F1 drafts: a name conflict is rescued before the old key can edit another note", async () => {
  const f = fixture();
  f.drafts.set("lyra-draft:Same.md", JSON.stringify({ content: "pending original", updatedAt: 1 }));
  f.notes.set("Same.md", "adopted destination");
  const rescued = await rescueMigratedDrafts(["Same.md"], f.storage, f.files);
  assert.equal(rescued.length, 1);
  assert.equal(f.notes.get(rescued[0]), "pending original");
  assert.equal(f.notes.get("Same.md"), "adopted destination");
  assert.equal(f.drafts.has("lyra-draft:Same.md"), false);
});

test("F1 drafts: failed rescue keeps the draft and the destination untouched", async () => {
  const f = fixture();
  f.drafts.set("lyra-draft:Same.md", JSON.stringify({ content: "pending original", updatedAt: 1 }));
  f.notes.set("Same.md", "adopted destination");
  await assert.rejects(rescueMigratedDrafts(["Same.md"], f.storage, {
    ...f.files,
    createExclusive: async () => { throw new Error("disk unavailable"); },
  }), /disk unavailable/);
  assert.equal(f.drafts.has("lyra-draft:Same.md"), true);
  assert.equal(f.notes.get("Same.md"), "adopted destination");
});

test("F1 drafts: malformed payload blocks startup without discarding it", async () => {
  const f = fixture();
  f.drafts.set("lyra-draft:Same.md", "{bad");
  await assert.rejects(rescueMigratedDrafts(["Same.md"], f.storage, f.files), /No se pudo leer/);
  assert.equal(f.drafts.get("lyra-draft:Same.md"), "{bad");
});

test("F1 drafts: a failed read-back keeps the original draft for retry", async () => {
  const f = fixture();
  f.drafts.set("lyra-draft:Same.md", JSON.stringify({ content: "pending original", updatedAt: 1 }));
  await assert.rejects(rescueMigratedDrafts(["Same.md"], f.storage, {
    ...f.files,
    read: async () => "different bytes",
  }), /verificar el rescate/);
  assert.equal(f.drafts.has("lyra-draft:Same.md"), true);
});
