import { getFileDirectory } from "./noteName.ts";
import type { FolderOrder } from "./folderTree.ts";

export type FileOrderCapture = () => FolderOrder | null;

let captureProvider: FileOrderCapture | null = null;

/** Registra la fuente del orden visual actual del explorador. */
export function registerFileOrderCapture(provider: FileOrderCapture): () => void {
  captureProvider = provider;
  return () => {
    if (captureProvider === provider) captureProvider = null;
  };
}

/** Captura el orden visible actualmente; devuelve null si el explorador no está montado. */
export function captureCurrentFileOrder(): FolderOrder | null {
  return captureProvider ? captureProvider() : null;
}

/** Agrupa rutas por carpeta conservando el orden de entrada dentro de cada carpeta. */
export function buildFileOrderFromPaths(paths: Iterable<string>): FolderOrder {
  const order: FolderOrder = {};
  for (const path of paths) {
    if (!path) continue;
    const parent = getFileDirectory(path);
    (order[parent] ??= []).push(path);
  }
  return order;
}

/**
 * Sustituye por completo las carpetas capturadas y conserva las entradas de
 * carpetas que no participaron de la captura (por ejemplo, archivadas).
 */
export function mergeCapturedFileOrder(current: FolderOrder, captured: FolderOrder): FolderOrder {
  const next: FolderOrder = {};
  for (const [parent, paths] of Object.entries(current)) {
    if (Array.isArray(paths)) next[parent] = [...paths];
  }
  for (const [parent, paths] of Object.entries(captured)) {
    if (Array.isArray(paths)) next[parent] = [...paths];
  }
  return next;
}

export function readStoredFileOrder(): FolderOrder {
  try {
    const raw = window.localStorage.getItem("fileOrder");
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as FolderOrder)
      : {};
  } catch {
    return {};
  }
}

export function writeStoredFileOrder(order: FolderOrder): void {
  try {
    window.localStorage.setItem("fileOrder", JSON.stringify(order));
  } catch {}
}
