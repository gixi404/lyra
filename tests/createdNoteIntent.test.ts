import test from "node:test";
import assert from "node:assert/strict";
import {
  clearCreatedNoteIntent,
  consumeCreatedNoteIntent,
  expandCreatedNoteOnReturn,
  getCreatedNoteIntent,
  setCreatedNoteIntent,
} from "../src/utils/createdNoteIntent.ts";

test("registra y expone la intención de navegación para la nota recién creada", () => {
  clearCreatedNoteIntent();
  setCreatedNoteIntent("Carpeta/Nueva.txt", "active");
  assert.deepEqual(getCreatedNoteIntent(), { fileName: "Carpeta/Nueva.txt", view: "active" });
  clearCreatedNoteIntent();
});

test("expande la carpeta de la nota solo al regresar y conserva el estado de las demás", () => {
  clearCreatedNoteIntent();
  setCreatedNoteIntent("Trabajo/Sub/Nueva.txt", "active");
  const stored = { "root:lyra": true, Trabajo: false, "Trabajo/Sub": false, Otra: false };
  let persisted: string | null = null;
  const storage = { getItem: () => persisted ?? JSON.stringify(stored) };
  assert.deepEqual(JSON.parse(storage.getItem()), stored);
  assert.equal(expandCreatedNoteOnReturn(storage, value => { persisted = value; }), true);
  assert.deepEqual(JSON.parse(persisted!), { "root:lyra": true, Trabajo: true, "Trabajo/Sub": true, Otra: false });
  assert.deepEqual(getCreatedNoteIntent(), { fileName: "Trabajo/Sub/Nueva.txt", view: "active" });
  assert.equal(expandCreatedNoteOnReturn(storage, value => { persisted = value; }), false);
  clearCreatedNoteIntent();
});

test("consume la intención una sola vez para la nota identificada", () => {
  clearCreatedNoteIntent();
  setCreatedNoteIntent("Nota.txt", "active");
  assert.deepEqual(consumeCreatedNoteIntent("Nota.txt"), { fileName: "Nota.txt", view: "active" });
  assert.equal(getCreatedNoteIntent(), null);
  assert.equal(consumeCreatedNoteIntent("Nota.txt"), null);
});

test("no consume la intención si el identificador no coincide", () => {
  clearCreatedNoteIntent();
  setCreatedNoteIntent("A.txt", "active");
  assert.equal(consumeCreatedNoteIntent("B.txt"), null);
  assert.deepEqual(getCreatedNoteIntent(), { fileName: "A.txt", view: "active" });
  clearCreatedNoteIntent();
});

test("la creación consecutiva reemplaza la intención pendiente hasta que se consuma", () => {
  clearCreatedNoteIntent();
  setCreatedNoteIntent("Primera.txt", "active");
  setCreatedNoteIntent("Segunda.txt", "active");
  assert.deepEqual(getCreatedNoteIntent(), { fileName: "Segunda.txt", view: "active" });
  assert.equal(consumeCreatedNoteIntent("Primera.txt"), null);
  assert.deepEqual(consumeCreatedNoteIntent("Segunda.txt"), { fileName: "Segunda.txt", view: "active" });
  assert.equal(getCreatedNoteIntent(), null);
});
