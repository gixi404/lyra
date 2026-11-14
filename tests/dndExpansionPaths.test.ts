import test from "node:test";
import assert from "node:assert/strict";
import { ancestorsOf, keepExpandedPathsForContainer } from "../src/utils/dndExpansion.ts";

test("ancestorsOf: raíz vacía no persiste carpeta expandida", () => {
  assert.deepEqual(ancestorsOf(""), []);
  assert.deepEqual(keepExpandedPathsForContainer(""), []);
});

test("ancestorsOf: incluye destino y todos sus ancestros", () => {
  assert.deepEqual(ancestorsOf("A"), ["A"]);
  assert.deepEqual(ancestorsOf("A/B"), ["A", "A/B"]);
  assert.deepEqual(ancestorsOf("A/B/C"), ["A", "A/B", "A/B/C"]);
});

test("keepExpandedPathsForContainer: éxito sobre carpeta destino mantiene destino y ancestros", () => {
  assert.deepEqual(keepExpandedPathsForContainer("Proyectos"), ["Proyectos"]);
  assert.deepEqual(keepExpandedPathsForContainer("Proyectos/Sub"), ["Proyectos", "Proyectos/Sub"]);
});
