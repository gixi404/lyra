import test from "node:test";
import assert from "node:assert/strict";
import { displayNoteName } from "../src/utils/visibleNames.ts";
import { getHighlightSegments, hasNormalizedMatch } from "../src/utils/searchHighlight.ts";

function parts(segments: Array<{ text: string; highlight: boolean }>) {
  return segments.map(segment => [segment.text, segment.highlight] as const);
}

test("resalta coincidencias parciales en el nombre visible", () => {
  assert.deepEqual(parts(getHighlightSegments("Mi proyecto personal", "proyecto")), [
    ["Mi ", false],
    ["proyecto", true],
    [" personal", false],
  ]);
});

test("resalta todas las coincidencias múltiples", () => {
  assert.deepEqual(parts(getHighlightSegments("Proyecto de otro proyecto", "proyecto")), [
    ["Proyecto", true],
    [" de otro ", false],
    ["proyecto", true],
  ]);
});

test("coincide sin distinguir mayúsculas y acentos", () => {
  assert.deepEqual(parts(getHighlightSegments("Proyectos pendientes", "proyecto")), [
    ["Proyecto", true],
    ["s pendientes", false],
  ]);
  assert.deepEqual(parts(getHighlightSegments("Configuración de canción", "cancion")), [
    ["Configuración de ", false],
    ["canción", true],
  ]);
});

test("maneja caracteres especiales del buscador como texto literal", () => {
  assert.deepEqual(parts(getHighlightSegments("C++ (guía).md".replace(/\.md$/, ""), "c++ (guía)")), [
    ["C++ (guía)", true],
  ]);
  assert.equal(hasNormalizedMatch("Regex [test]", "[test]"), true);
});

test("no resalta cuando la consulta está vacía o no coincide en el nombre visible", () => {
  assert.deepEqual(parts(getHighlightSegments("Mi proyecto", "")), [["Mi proyecto", false]]);
  assert.deepEqual(parts(getHighlightSegments("Mi proyecto", "   ")), [["Mi proyecto", false]]);
  assert.deepEqual(parts(getHighlightSegments("Mi proyecto", "finanzas")), [["Mi proyecto", false]]);
  assert.equal(hasNormalizedMatch("Mi proyecto", "finanzas"), false);
});

test("respeta nombres visibles personalizados al calcular el resaltado", () => {
  const original = globalThis.window;
  const storage = new Map<string, string>([
    ["noteVisibleNames", JSON.stringify({ "docs/abc123.txt": "Plan estratégico" })],
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  };
  try {
    const visible = displayNoteName("docs/abc123.txt");
    assert.equal(visible, "Plan estratégico");
    assert.deepEqual(parts(getHighlightSegments(visible, "estrategico")), [
      ["Plan ", false],
      ["estratégico", true],
    ]);
    // Coincidencia solo por nombre físico: el nombre visible no debe resaltarse.
    assert.equal(hasNormalizedMatch(visible, "abc123"), false);
  } finally {
    (globalThis as unknown as { window?: unknown }).window = original;
  }
});
