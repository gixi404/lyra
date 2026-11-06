import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "../store/toastStore.ts";
import { fileStore } from "../store/fileStore.ts";
import { noteLabel } from "./noteName.ts";
import { logger } from "./logger.ts";

const notifiedNotes = new Set<string>();
let pendingBatch: string[] = [];
let batchTimeout: ReturnType<typeof setTimeout> | null = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;
let unlistenRecovered: (() => void) | null = null;

export interface RecoveryNotifierTransport {
  available: () => boolean;
  register: (handler: (notes: string[]) => void) => Promise<() => void>;
  drain: () => Promise<string[]>;
}

const defaultTransport: RecoveryNotifierTransport = {
  available: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  register: handler => listen<string[]>("lyra:notes_recovered", event => handler(event.payload)),
  drain: () => invoke<string[]>("check_and_drain_recovered_notes"),
};

/**
 * Procesa una lista de nombres de notas recuperadas.
 * Deduplica para evitar notificaciones repetidas por el mismo archivo
 * y agrupa notificaciones concurrentes en una sola notificación.
 */
export function handleRecoveredNotes(notes: string[]): void {
  if (!Array.isArray(notes) || notes.length === 0) return;

  const newNotes = notes.filter(
    n => typeof n === "string" && n.trim().length > 0 && !notifiedNotes.has(n)
  );
  if (newNotes.length === 0) return;

  for (const n of newNotes) {
    notifiedNotes.add(n);
  }
  pendingBatch.push(...newNotes);

  if (batchTimeout) {
    clearTimeout(batchTimeout);
  }

  batchTimeout = setTimeout(() => {
    flushRecoveredBatch();
  }, 100);
}

/**
 * Emite la notificación agrupada pendiente a través del store de toasts de Lyra
 * y refresca el listado de archivos.
 */
export function flushRecoveredBatch(): void {
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }

  const count = pendingBatch.length;
  if (count === 0) return;

  const recovered = pendingBatch;
  pendingBatch = [];

  // Refrescar el listado visual de archivos para mostrar las notas recuperadas
  try {
    fileStore.getState().editedFile();
  } catch {}

  const msg =
    count === 1
      ? `Se recuperó ${noteLabel(recovered[0])} después de un guardado interrumpido`
      : `Se recuperaron ${count} notas después de un guardado interrumpido`;

  // Toast informativo con 7000ms de duración para garantizar visibilidad al usuario
  useToastStore.getState().addToast("info", msg, undefined, 7000);
}

/**
 * Inicializa el mecanismo de escucha y consulta de notas recuperadas desde Rust.
 * Protege contra pérdidas de eventos tempranos durante el arranque consultando
 * y drenando la cola persistente del backend.
 */
export function initRecoveryNotifier(transport: RecoveryNotifierTransport = defaultTransport): Promise<void> {
  if (isInitialized) return Promise.resolve();
  if (initPromise) return initPromise;
  if (!transport.available()) {
    return Promise.resolve();
  }
  initPromise = initializeRecoveryNotifier(transport).finally(() => { initPromise = null; });
  return initPromise;
}

async function initializeRecoveryNotifier(transport: RecoveryNotifierTransport): Promise<void> {
  let unlisten: (() => void) | null = null;
  try {
    // 1. Registrar listener para eventos que ocurran mientras la app está activa
    unlisten = await transport.register(notes => {
      if (Array.isArray(notes)) {
        handleRecoveredNotes(notes);
      }
    });

    // 2. Drenar cualquier nota recuperada en el arranque antes del montaje de la interfaz
    const pending = await transport.drain();
    if (Array.isArray(pending) && pending.length > 0) {
      handleRecoveredNotes(pending);
    }
    unlistenRecovered = unlisten;
    isInitialized = true;
  } catch (e) {
    unlisten?.();
    logger.warn("[RecoveryNotifier] Error al inicializar notificador de recuperaciones:", e);
  }
}

/**
 * Función exclusiva para reiniciar el estado interno durante pruebas unitarias.
 */
export function _resetRecoveryNotifierForTesting(): void {
  unlistenRecovered?.();
  unlistenRecovered = null;
  initPromise = null;
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }
  pendingBatch = [];
  notifiedNotes.clear();
  isInitialized = false;
}
