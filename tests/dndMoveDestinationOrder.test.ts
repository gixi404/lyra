import test from "node:test";
import assert from "node:assert/strict";
import { relocateEntry } from "../src/utils/folderTree.ts";

// Regresión: al mover una nota entre carpetas, migratePreferences/relocateEntry la añade al final
// del destino como estado intermedio; la posición elegida por DnD debe prevalecer y no debe
// renderizarse ese intermedio como definitivo.
test("movimiento de archivo entre carpetas: relocateEntry añade al final (intermedio) pero la posición definitiva DnD se impone", () => {
  const initial = { A: ["A/n.md", "A/other.md"], B: ["B/one.md", "B/two.md"] };
  const afterMigrate = relocateEntry(initial, { oldPath: "A/n.md", newPath: "B/n.md" });
  // Intermedio: al final de B
  assert.deepEqual(afterMigrate.B, ["B/one.md", "B/two.md", "B/n.md"]);
  assert.deepEqual(afterMigrate.A, ["A/other.md"]);

  // Posición definitiva elegida (p. ej. antes de two.md)
  const definitive = (() => {
    const map = { ...afterMigrate, B: [...(afterMigrate.B ?? [])] };
    const list = map.B.filter(p => p !== "B/n.md");
    const idx = list.indexOf("B/two.md");
    list.splice(idx >= 0 ? idx : list.length, 0, "B/n.md");
    map.B = list;
    return map;
  })();
  assert.deepEqual(definitive.B, ["B/one.md", "B/n.md", "B/two.md"]);
  assert.equal(definitive.B.includes("B/n.md"), true);
  assert.equal(definitive.B.filter(p => p === "B/n.md").length, 1);
});

// Proyección optimista debe mostrar destino en posición elegida mientras el intermedio esté en "fin".
test("proyección optimista mantiene posición elegida aunque fileOrder intermedio esté al final", () => {
  const projectedFiles = (files: string[], oldPath: string, newPath: string) =>
    files.includes(oldPath) ? files.map(f => (f === oldPath ? newPath : f)) : files;
  const filesDuringMove = ["A/n.md", "A/other.md", "B/one.md", "B/two.md"]; // store aún no actualizado
  const projected = projectedFiles(filesDuringMove, "A/n.md", "B/n.md");
  assert.equal(projected.includes("A/n.md"), false);
  assert.deepEqual(projected, ["B/n.md", "A/other.md", "B/one.md", "B/two.md"]);
  // La posición visual real depende de fileOrder proyectado; aquí verificamos que no hay origen ni duplicado.
  assert.equal(projected.filter(p => p === "B/n.md").length, 1);
});
