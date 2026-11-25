import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relativePath: string): string => readFileSync(join(root, relativePath), "utf8");

const modalSource = readSource("src/components/SearchReplaceModal.tsx");
const editorSource = readSource("src/components/TinyEditor.tsx");

test("Ctrl+F: fondo opaco en el contenedor completo, sin transparencia ni backdrop-blur", () => {
  assert.equal(
    modalSource.includes("backdrop-blur"),
    false,
    "el panel no debe desenfocar ni dejar ver el editor detrás"
  );
  assert.equal(modalSource.includes("/95"), false, "los colores de fondo no deben ser semitransparentes");

  const containerStart = modalSource.indexOf("<animated.div");
  assert.ok(containerStart !== -1);
  const containerEnd = modalSource.indexOf(">", containerStart);
  const container = modalSource.slice(containerStart, containerEnd);
  assert.ok(container.includes("search-replace-modal"), "el fondo se aplica al panel, no a los inputs");
  assert.ok(container.includes("bg-white") && container.includes("bg-zinc-900"),
    "tema claro y oscuro deben usar fondos sólidos");

  assert.ok(modalSource.includes('? "bg-white text-neutral-800'));
  assert.ok(modalSource.includes(': "bg-zinc-900 text-zinc-100'));
  assert.equal(modalSource.includes("bg-white/"), false);
  assert.equal(modalSource.includes("bg-zinc-900/"), false);

  // El diseño, dimensiones y animaciones existentes permanecen intactos.
  assert.ok(modalSource.includes("useTransition(isOpen"));
  assert.ok(modalSource.includes("opacity: styles.opacity"));
  assert.ok(modalSource.includes("transform: styles.transform"));
  assert.ok(modalSource.includes("duration: 150"));
  assert.ok(modalSource.includes("w-[340px] sm:w-[380px]"));
});

test("Ctrl+F: cualquier cierre limpia ambos campos y los resaltados sin escribir el documento", () => {
  const resetStart = modalSource.indexOf('setSearchQuery("");');
  assert.ok(resetStart !== -1, "debe existir una limpieza al cerrar");
  const resetEnd = modalSource.indexOf("}, [isOpen", resetStart);
  assert.ok(resetEnd !== -1);
  const resetBlock = modalSource.slice(resetStart, resetEnd);

  for (const token of [
    'setSearchQuery("")',
    'setReplaceQuery("")',
    "setMatchIndices([])",
    "setCurrentMatchIndex(0)",
    'getElementById("search-scroll-mirror")?.remove()',
    "onSearchStateChange?.(null)",
  ]) {
    assert.ok(resetBlock.includes(token), `la limpieza debe incluir ${token}`);
  }

  assert.equal(
    resetBlock.includes("onContentChange"),
    false,
    "limpiar la búsqueda no debe modificar ni guardar el contenido"
  );

  // Todos los mecanismos de cierre reducen el mismo estado isOpen.
  assert.ok(editorSource.includes('setIsSearchOpen(false)'));
  assert.ok(editorSource.includes("setIsSearchOpen(prev => !prev)"));
  assert.ok(modalSource.includes("onClick={onClose}"));
  assert.ok(modalSource.includes('e.key === "Escape"'));
  assert.ok(modalSource.includes("handleClickOutside"));

  // La limpieza es idempotente: repetir el cierre no debería introducir escritura alguna.
  const closeCalls = modalSource.match(/onClose\(\)/g) ?? [];
  assert.ok(closeCalls.length >= 3, "botón, Escape y clic fuera comparten el mismo cierre");
});

test("El textarea del editor no muestra placeholder y conserva escritura, selección y ortografía", () => {
  assert.equal(
    editorSource.includes("placeholder="),
    false,
    "el área de escritura no debe mostrar texto indicativo"
  );

  const textareaStart = editorSource.indexOf("<textarea");
  assert.ok(textareaStart !== -1);
  const textareaEnd = editorSource.indexOf("/>", textareaStart);
  const textarea = editorSource.slice(textareaStart, textareaEnd);

  for (const token of [
    "value={content}",
    "onChange={handleChange}",
    "onSelect={handleInteractionWithDebug}",
    "spellCheck",
    "editor-textarea",
  ]) {
    assert.ok(textarea.includes(token), "se conserva el comportamiento del textarea: " + token);
  }
});
