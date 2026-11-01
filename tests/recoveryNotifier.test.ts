import test from "node:test";
import assert from "node:assert";
import { useToastStore } from "../src/store/toastStore.ts";
import {
  handleRecoveredNotes,
  flushRecoveredBatch,
  _resetRecoveryNotifierForTesting,
} from "../src/utils/recoveryNotifier.ts";

test("AUD-004 Notificación: Recuperación de una sola nota emite toast informativo en formato singular sin punto final", () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();

  handleRecoveredNotes(["nota_importante (recuperado de guardado 20261031_120000).txt"]);
  flushRecoveredBatch();

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1, "Debe registrarse exactamente 1 toast");

  const toast = toasts[0];
  assert.strictEqual(toast.type, "info", "El toast debe ser de tipo 'info'");
  assert.strictEqual(
    toast.msg,
    "Se recuperó «nota_importante (recuperado de guardado 20261031_120000)» después de un guardado interrumpido",
    "El mensaje singular debe coincidir exactamente con el especificado"
  );
  assert.strictEqual(
    toast.msg.endsWith("."),
    false,
    "El mensaje del toast NO debe terminar con punto final"
  );
});

test("AUD-004 Notificación: Recuperación de múltiples notas en una operación emite notificación agrupada", () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();

  handleRecoveredNotes([
    "nota1 (recuperado de guardado 20261031_120000).txt",
    "nota2 (recuperado de guardado 20261031_120000).txt",
    "nota3 (recuperado de guardado 20261031_120000).txt",
  ]);
  flushRecoveredBatch();

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1, "Debe mostrarse 1 único toast agrupado");

  const toast = toasts[0];
  assert.strictEqual(toast.type, "info");
  assert.strictEqual(
    toast.msg,
    "Se recuperaron 3 notas después de un guardado interrumpido",
    "El mensaje plural debe reflejar el recuento agrupado"
  );
  assert.strictEqual(
    toast.msg.endsWith("."),
    false,
    "No debe incluir punto final"
  );
});

test("AUD-004 Notificación: Ausencia de notificación cuando la lista de recuperaciones está vacía", () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();

  handleRecoveredNotes([]);
  flushRecoveredBatch();

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 0, "No debe crearse ningún toast si no se recuperaron notas");
});

test("AUD-004 Notificación: Deduplicación estricta para evitar notificaciones repetidas por el mismo archivo", () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();

  const fileName = "mi_nota (recuperado de guardado 20261031_120000).txt";

  // Primera notificación
  handleRecoveredNotes([fileName]);
  flushRecoveredBatch();

  assert.strictEqual(useToastStore.getState().toasts.length, 1);

  // Segunda invocación con el mismo archivo
  handleRecoveredNotes([fileName]);
  flushRecoveredBatch();

  assert.strictEqual(
    useToastStore.getState().toasts.length,
    1,
    "No debe emitir un nuevo toast para una nota que ya fue notificada"
  );
});

test("AUD-004 Notificación: Eventos rápidos consecutivos se agrupan mediante ventana de debounce", async () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();

  // Dos emisiones casi simultáneas
  handleRecoveredNotes(["notaA (recuperado de guardado 20261031_120000).txt"]);
  handleRecoveredNotes(["notaB (recuperado de guardado 20261031_120000).txt"]);

  // Esperar a que el timer de batching (100ms) se ejecute de forma natural
  await new Promise(resolve => setTimeout(resolve, 150));

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1, "Debe agrupar las notas recibidas consecutivamente");
  assert.strictEqual(
    toasts[0].msg,
    "Se recuperaron 2 notas después de un guardado interrumpido"
  );
});

test("AUD-004 Notificación: Simulación de arranque temprano (drenado de cola previa a montaje de interfaz)", () => {
  _resetRecoveryNotifierForTesting();
  useToastStore.getState().clearToasts();

  // Simular que el backend en Rust recuperó 2 notas durante el inicio del proceso
  const pendingFromBackendStartup = [
    "resumen (recuperado de guardado 20261031_120000).txt",
    "ideas (recuperado de guardado 20261031_120000).txt",
  ];

  // Cuando React monta y consulta la cola persistente:
  handleRecoveredNotes(pendingFromBackendStartup);
  flushRecoveredBatch();

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1, "Las notas recuperadas tempranamente en el arranque deben notificarse");
  assert.strictEqual(
    toasts[0].msg,
    "Se recuperaron 2 notas después de un guardado interrumpido"
  );
});
