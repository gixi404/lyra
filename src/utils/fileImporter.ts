import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { fileStore } from "../store/fileStore.ts";
import { useToastStore, type ToastAction, type ToastType } from "../store/toastStore.ts";
import { noteLabel } from "./noteName.ts";
import { BASE_DIRECTORY, MAIN_FOLDER, PAGES } from "./consts.ts";
import { navigateTo } from "./navigation.ts";
import { flushActiveEditors } from "./editorPersistence.ts";
import { logger } from "./logger.ts";

function notification(
  type: ToastType,
  msg: string,
  action?: ToastAction,
  durationMs?: number
): void {
  useToastStore.getState().addToast(type, msg, action, durationMs);
}

export interface ImportedItem {
  original_path: string;
  file_name: string;
  size: number;
  is_internal?: boolean;
}

export interface ImportErrorItem {
  path: string;
  error: string;
}

export interface ImportBatchResponse {
  imported: ImportedItem[];
  errors: ImportErrorItem[];
}

let isImportInProgress = false;
const recentlyImportedPaths = new Map<string, number>();
const DEDUP_WINDOW_MS = 1000;

function pruneRecentPaths(): void {
  const now = Date.now();
  for (const [p, timestamp] of recentlyImportedPaths.entries()) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentlyImportedPaths.delete(p);
    }
  }
}

export async function readImportedNoteContent(fileName: string): Promise<string> {
  const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
  if (isTauri) {
    try {
      const pathFile = await join(MAIN_FOLDER, fileName);
      return await readTextFile(pathFile, BASE_DIRECTORY);
    } catch {
      try {
        return await readTextFile(`${MAIN_FOLDER}/${fileName}`, BASE_DIRECTORY);
      } catch {
        return "";
      }
    }
  }
  return "";
}

/**
 * Importa uno o varios archivos externos al directorio de notas de Lyra mediante copia segura.
 * Respeta los cambios pendientes del editor antes de navegar a la nota importada.
 */
export async function handleExternalFileImport(paths: string[]): Promise<boolean> {
  if (!paths || paths.length === 0) return false;

  pruneRecentPaths();
  const now = Date.now();

  // Filtrar rutas repetidas en una misma ráfaga de eventos del sistema operativo
  const candidatePaths = paths.filter(p => {
    const last = recentlyImportedPaths.get(p);
    if (last && now - last < DEDUP_WINDOW_MS) {
      return false;
    }
    return true;
  });

  if (candidatePaths.length === 0) {
    return false;
  }

  for (const p of candidatePaths) {
    recentlyImportedPaths.set(p, now);
  }

  if (isImportInProgress) {
    // Si ya hay una importación en curso, encolar tras breve pausa
    setTimeout(() => {
      void handleExternalFileImport(candidatePaths);
    }, 150);
    return false;
  }

  isImportInProgress = true;

  try {
    const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
    if (!isTauri) {
      logger.warn("Importación externa no disponible fuera de Tauri");
      return false;
    }

    const response = await invoke<ImportBatchResponse>("import_external_files", {
      paths: candidatePaths,
    });

    // 1. Notificar errores específicos de archivos rechazados o incompatibles
    if (response.errors && response.errors.length > 0) {
      for (const err of response.errors) {
        notification("error", err.error);
      }
    }

    // Si no hubo ningún archivo importado exitosamente, concluir aquí
    if (!response.imported || response.imported.length === 0) {
      return false;
    }

    // 2. Registrar los archivos importados en el store local de notas
    for (const item of response.imported) {
      fileStore.getState().updateListFiles(item.file_name);
    }

    const firstItem = response.imported[0];
    const currentSelected = fileStore.getState().selectedFile;
    const isAlreadyOpen = currentSelected.name === firstItem.file_name;

    // Caso B: Si la nota ya está abierta en el editor activo, reutilizarla y enfocarla
    // sin re-leer de disco ni perder ediciones en memoria ni duplicar
    if (isAlreadyOpen) {
      navigateTo(PAGES.file);
      setTimeout(() => {
        if (typeof document !== "undefined") {
          const textarea = document.querySelector<HTMLTextAreaElement>(".editor-textarea");
          textarea?.focus();
        }
      }, 50);
      return true;
    }

    // 3. Proteger cambios pendientes en el editor activo antes de cambiar de nota
    const savedSuccessfully = await flushActiveEditors();
    if (!savedSuccessfully) {
      notification(
        "error",
        "Los archivos se importaron correctamente, pero no se pudo abrir la nota porque hay cambios pendientes que no pudieron guardarse."
      );
      return true;
    }

    // 4. Abrir la primera nota importada o interna
    const content = await readImportedNoteContent(firstItem.file_name);

    fileStore.getState().setSelectedFile({
      name: firstItem.file_name,
      content,
    });
    navigateTo(PAGES.file);
    setTimeout(() => {
      if (typeof document !== "undefined") {
        const textarea = document.querySelector<HTMLTextAreaElement>(".editor-textarea");
        textarea?.focus();
      }
    }, 50);

    // 5. Notificación al usuario solo cuando se importen copias de archivos externos
    const externalImported = response.imported.filter(item => !item.is_internal);
    if (externalImported.length === 1) {
      notification("success", `${noteLabel(externalImported[0].file_name)} se importó correctamente`);
    } else if (externalImported.length > 1) {
      notification(
        "success",
        `Se importaron ${externalImported.length} archivos (abriendo ${noteLabel(firstItem.file_name)})`
      );
    }

    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    notification("error", `Error al importar archivos: ${msg}`);
    return false;
  } finally {
    isImportInProgress = false;
  }
}

let isListenerInitialized = false;

/**
 * Inicializa los escuchadores de apertura externa desde el sistema operativo
 * tanto para cold-start (get_pending_open_files) como para runtime (lyra://open-files).
 */
export async function initExternalFileListener(): Promise<() => void> {
  if (isListenerInitialized) return () => {};
  isListenerInitialized = true;

  const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
  if (!isTauri) return () => {};

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await listen<string[]>("lyra://open-files", (event) => {
      if (Array.isArray(event.payload) && event.payload.length > 0) {
        void handleExternalFileImport(event.payload);
      }
    });
  } catch (err) {
    logger.warn("No se pudo registrar listener lyra://open-files:", err);
  }

  // Drenar archivos recibidos en arranque en frío tras montar la aplicación
  setTimeout(async () => {
    try {
      const pending = await invoke<string[]>("get_pending_open_files");
      if (Array.isArray(pending) && pending.length > 0) {
        void handleExternalFileImport(pending);
      }
    } catch (err) {
      logger.warn("No se pudo obtener archivos pendientes de arranque:", err);
    }
  }, 350);

  return () => {
    unlisten?.();
    isListenerInitialized = false;
  };
}

