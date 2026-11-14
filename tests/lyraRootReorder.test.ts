import test from "node:test";
import assert from "node:assert/strict";
import { buildFolderTree, reorderEntries } from "../src/utils/folderTree.ts";

test("reordenar notas sueltas en Lyra (raíz, clave fileOrder \"\") actualiza y respeta el orden", () => {
  const files = ["b.md", "a.md", "c.md"];
  const fileOrder = { "": ["a.md", "b.md", "c.md"] };
  const tree = buildFolderTree([], files, {}, fileOrder);
  assert.deepEqual(tree.files, ["a.md", "b.md", "c.md"]);

  // mover c.md antes de a.md dentro de Lyra (clave raíz "")
  const next = reorderEntries(fileOrder, "", ["a.md", "b.md", "c.md"], "c.md", "a.md");
  assert.deepEqual(next[""], ["c.md", "a.md", "b.md"]);
  const tree2 = buildFolderTree([], files, {}, next);
  assert.deepEqual(tree2.files, ["c.md", "a.md", "b.md"]);
});

test("orden de notas en Lyra persiste en fileOrder bajo clave vacía (no $top)", () => {
  const before = { "": ["n1.md", "n2.md"], Carpeta: ["Carpeta/x.md"] };
  const updated = reorderEntries(before, "", ["n1.md", "n2.md"], "n2.md", "n1.md");
  assert.equal(Object.prototype.hasOwnProperty.call(updated, "$top"), false);
  assert.deepEqual(updated[""], ["n2.md", "n1.md"]);
  assert.deepEqual(updated["Carpeta"], ["Carpeta/x.md"]);
});
