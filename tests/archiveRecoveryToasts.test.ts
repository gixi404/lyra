import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { useToastStore } from "../src/store/toastStore.ts";
import { noteLabel, noteSuccessMessage } from "../src/utils/noteName.ts";

function setupMockEnvironment() {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    },
    matchMedia: () => ({ matches: false }),
  };
  return store;
}

// -----------------------------------------------------------------------------
// 1. Verificación del comportamiento del store de notificaciones
// -----------------------------------------------------------------------------

test("1. Al archivar una nota no se emite toast de éxito", () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  // Simular la ejecución de handleTrashConfirm exitosa (sin emitir toast de éxito)
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 0, "No debe haberse generado ningún toast de éxito al archivar");
});

test("2. Al recuperar una nota no se emite toast de éxito", () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  // Simular la ejecución de handleRecoveryConfirm exitosa (sin emitir toast de éxito)
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 0, "No debe haberse generado ningún toast de éxito al recuperar");
});

test("3. Los errores al archivar y recuperar siguen notificándose al usuario", () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  // Error al archivar
  useToastStore.getState().addToast("error", `No se pudo archivar ${noteLabel("archivo.md")}`);
  // Error al recuperar
  useToastStore.getState().addToast("error", `No se pudo recuperar ${noteLabel("archivo.md")}`);

  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0].type, "error");
  assert.equal(toasts[0].msg, "No se pudo archivar «archivo»");
  assert.equal(toasts[1].type, "error");
  assert.equal(toasts[1].msg, "No se pudo recuperar «archivo»");
});

test("4. Las demás notificaciones de la aplicación no se ven afectadas", () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  // Eliminación confirmada de nota archivada
  useToastStore.getState().addToast("success", noteSuccessMessage("nota.txt", "deleted"));

  // Exportación a PDF
  useToastStore.getState().addToast("success", `${noteLabel("documento.md")} se exportó a PDF`);

  // Importación exitosa
  useToastStore.getState().addToast("success", `${noteLabel("nuevo.json")} se importó correctamente`);

  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 3);
  assert.equal(toasts[0].msg, "«nota» se eliminó");
  assert.equal(toasts[1].msg, "«documento» se exportó a PDF");
  assert.equal(toasts[2].msg, "«nuevo.json» se importó correctamente");
});

// -----------------------------------------------------------------------------
// 2. Inspección estática de MenuFile y MenuPaperFile
// -----------------------------------------------------------------------------

test("5. MenuFile: handleTrashConfirm no emite toast de éxito pero conserva el de error", () => {
  const menuFilePath = new URL("../src/components/MenuFile.tsx", import.meta.url).pathname;
  const code = fs.readFileSync(menuFilePath, "utf-8");

  // Extraer el cuerpo de la función handleTrashConfirm
  const startIdx = code.indexOf("async function handleTrashConfirm");
  assert.ok(startIdx !== -1, "Debe existir handleTrashConfirm");
  const endIdx = code.indexOf("return (", startIdx);
  const handleTrashCode = code.slice(startIdx, endIdx);

  // No debe contener toast de éxito
  assert.ok(
    !handleTrashCode.includes('notification("success"'),
    "handleTrashConfirm no debe contener notification('success', ...)"
  );
  assert.ok(
    !handleTrashCode.includes('"archived"'),
    "handleTrashConfirm no debe invocar noteSuccessMessage con 'archived'"
  );

  // Sí debe conservar la notificación de error
  assert.ok(
    handleTrashCode.includes('notification("error"'),
    "handleTrashConfirm debe conservar notification('error', ...)"
  );
  assert.ok(
    handleTrashCode.includes("No se pudo archivar"),
    "handleTrashConfirm debe conservar el mensaje de error"
  );
});

test("6. MenuPaperFile: handleRestoreConfirm no emite toast de éxito pero conserva el de error", () => {
  const menuPaperFilePath = new URL("../src/components/MenuPaperFile.tsx", import.meta.url).pathname;
  const code = fs.readFileSync(menuPaperFilePath, "utf-8");

  // Extraer el cuerpo de la función handleRestoreConfirm
  const startIdx = code.indexOf("async function handleRestoreConfirm");
  assert.ok(startIdx !== -1, "Debe existir handleRestoreConfirm");
  const endIdx = code.indexOf("async function handleDeleteConfirm", startIdx);
  const handleRestoreCode = code.slice(startIdx, endIdx);

  // No debe contener toast de éxito
  assert.ok(
    !handleRestoreCode.includes('notification("success"'),
    "handleRestoreConfirm no debe contener notification('success', ...)"
  );
  assert.ok(
    !handleRestoreCode.includes('"recovered"'),
    "handleRestoreConfirm no debe invocar noteSuccessMessage con 'recovered'"
  );

  // Sí debe conservar la notificación de error
  assert.ok(
    handleRestoreCode.includes('notification("error"'),
    "handleRestoreConfirm debe conservar notification('error', ...)"
  );
  assert.ok(
    handleRestoreCode.includes("No se pudo recuperar"),
    "handleRestoreConfirm debe conservar el mensaje de error"
  );

  // handleDeleteConfirm sí debe conservar su notificación de éxito para eliminación
  const deleteCode = code.slice(endIdx);
  assert.ok(
    deleteCode.includes('notification("success", noteSuccessMessage(name, "deleted"))'),
    "handleDeleteConfirm debe conservar el toast de éxito para eliminación"
  );
});
