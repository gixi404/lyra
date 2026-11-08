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

export type ImportedNoteContent =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type ImportJobStatus = "completed" | "partial" | "failed" | "rejected";

export interface ImportJobOutcome {
  jobId: string;
  status: ImportJobStatus;
  imported: ImportedItem[];
  errors: ImportErrorItem[];
  reason?: string;
  openingError?: string;
}

export interface ImportJobHandle {
  jobId: string;
  promise: Promise<ImportJobOutcome>;
}

type PendingImportJob = {
  id: string;
  paths: string[];
  resolve: (outcome: ImportJobOutcome) => void;
};

const MAX_PENDING_IMPORTS = 32;
const pendingImportJobs: PendingImportJob[] = [];
let importWorkerActive = false;
let importJobCounter = 0;
const importOutcomeSubscribers = new Map<string, Set<(o: ImportJobOutcome) => void>>();

export function subscribeImportJob(
  jobId: string,
  listener: (outcome: ImportJobOutcome) => void,
): () => void {
  let set = importOutcomeSubscribers.get(jobId);
  if (!set) {
    set = new Set();
    importOutcomeSubscribers.set(jobId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) importOutcomeSubscribers.delete(jobId);
  };
}

function notifyImportOutcome(outcome: ImportJobOutcome): void {
  const set = importOutcomeSubscribers.get(outcome.jobId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(outcome);
    } catch (err) {
      logger.warn("import outcome subscriber failed:", err);
    }
  }
  importOutcomeSubscribers.delete(outcome.jobId);
}

/** Only for tests: reset FIFO queue and dedup state between cases. */
export function __resetImportQueueForTests(): void {
  pendingImportJobs.length = 0;
  importWorkerActive = false;
  recentlyImportedPaths.clear();
  importOutcomeSubscribers.clear();
}

export function __getImportQueueDepthForTests(): number {
  return pendingImportJobs.length;
}

export async function readImportedNoteContent(fileName: string): Promise<ImportedNoteContent> {
  const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
  if (!isTauri) {
    return { ok: false, error: "Lectura no disponible fuera de Tauri" };
  }
  try {
    const pathFile = await join(MAIN_FOLDER, fileName);
    const content = await readTextFile(pathFile, BASE_DIRECTORY);
    return { ok: true, content };
  } catch {
    try {
      const content = await readTextFile(`${MAIN_FOLDER}/${fileName}`, BASE_DIRECTORY);
      return { ok: true, content };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}

/**
 * Imports one or more external files via FIFO queue.
 * Each accepted job resolves its promise with a verifiable outcome
 * (independent of any component mounting). Dedup is sealed at
 * execution time, never at enqueue time.
 */
export function enqueueExternalFileImport(paths: string[]): ImportJobHandle {
  const jobId = `import-${++importJobCounter}-${Date.now().toString(36)}`;
  let resolveOutcome!: (outcome: ImportJobOutcome) => void;
  const promise = new Promise<ImportJobOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const uniquePaths = [...new Set((paths ?? []).filter(Boolean))];
  if (uniquePaths.length === 0) {
    const outcome: ImportJobOutcome = {
      jobId,
      status: "rejected",
      imported: [],
      errors: [],
      reason: "empty",
    };
    resolveOutcome(outcome);
    notifyImportOutcome(outcome);
    return { jobId, promise };
  }

  if (pendingImportJobs.length >= MAX_PENDING_IMPORTS) {
    const outcome: ImportJobOutcome = {
      jobId,
      status: "rejected",
      imported: [],
      errors: [{ path: uniquePaths[0], error: "Cola de importación llena" }],
      reason: "queue_full",
    };
    notification("error", "Cola de importación llena: no se pudo encolar el lote.");
    resolveOutcome(outcome);
    notifyImportOutcome(outcome);
    return { jobId, promise };
  }

  pendingImportJobs.push({ id: jobId, paths: uniquePaths, resolve: resolveOutcome });
  void pumpImportQueue();
  return { jobId, promise };
}

async function pumpImportQueue(): Promise<void> {
  if (importWorkerActive) return;
  importWorkerActive = true;
  try {
    while (pendingImportJobs.length > 0) {
      const job = pendingImportJobs.shift()!;
      let outcome: ImportJobOutcome;
      try {
        outcome = await executeImportJob(job);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = {
          jobId: job.id,
          status: "failed",
          imported: [],
          errors: [{ path: job.paths[0], error: msg }],
        };
      }
      notifyImportOutcome(outcome);
      job.resolve(outcome);
    }
  } finally {
    importWorkerActive = false;
  }
}

async function executeImportJob(job: PendingImportJob): Promise<ImportJobOutcome> {
  pruneRecentPaths();
  const now = Date.now();

  const candidatePaths = job.paths.filter((p) => {
    const last = recentlyImportedPaths.get(p);
    if (last && now - last < DEDUP_WINDOW_MS) return false;
    return true;
  });

  if (candidatePaths.length === 0) {
    return {
      jobId: job.id,
      status: "rejected",
      imported: [],
      errors: [],
      reason: "duplicate",
    };
  }

  const stampCandidates = (importedPaths: string[]): void => {
    const stamp = Date.now();
    for (const p of importedPaths) {
      recentlyImportedPaths.set(p, stamp);
    }
  };

  const isTauri =
    typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
  if (!isTauri) {
    logger.warn("Importación externa no disponible fuera de Tauri");
    // Sin backend: no sellar dedup (retry posible).
    return {
      jobId: job.id,
      status: "failed",
      imported: [],
      errors: [{ path: candidatePaths[0], error: "Importación no disponible fuera de Tauri" }],
    };
  }

  const response = await invoke<ImportBatchResponse>("import_external_files", {
    paths: candidatePaths,
  });
  const imported = response.imported ?? [];
  const errors = [...(response.errors ?? [])];

  // M2-1: sellado al finalizar, solo rutas realmente importadas.
  // Failed/partial-failed NO bloquean el reintento inmediato.
  const importedPaths = imported
    .map((i) => i.original_path)
    .filter((p) => candidatePaths.includes(p));
  stampCandidates(importedPaths);

  for (const err of errors) {
    notification("error", err.error);
  }

  if (imported.length === 0) {
    return {
      jobId: job.id,
      status: errors.length > 0 ? "failed" : "failed",
      imported: [],
      errors,
    };
  }

  for (const item of imported) {
    fileStore.getState().updateListFiles(item.file_name);
  }

  const finish = (openingError?: string): ImportJobOutcome => ({
    jobId: job.id,
    status: errors.length > 0 ? "partial" : "completed",
    imported,
    errors,
    ...(openingError ? { openingError } : {}),
  });

  const firstItem = imported[0];
  const currentSelected = fileStore.getState().selectedFile;
  const isAlreadyOpen = currentSelected.name === firstItem.file_name;

  if (isAlreadyOpen) {
    navigateTo(PAGES.file);
    setTimeout(() => {
      if (typeof document !== "undefined") {
        const textarea = document.querySelector<HTMLTextAreaElement>(".editor-textarea");
        textarea?.focus();
      }
    }, 50);
    return finish();
  }

  const savedSuccessfully = await flushActiveEditors();
  if (!savedSuccessfully) {
    const msg =
      "Los archivos se importaron correctamente, pero no se pudo abrir la nota porque hay cambios pendientes que no pudieron guardarse.";
    notification("error", msg);
    return finish(msg);
  }

  const res = await readImportedNoteContent(firstItem.file_name);
  if (!res.ok) {
    const msg = `No se pudo leer ${noteLabel(firstItem.file_name)}: ${res.error}`;
    notification("error", msg);
    return finish(msg);
  }
  const content = res.content;
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

  const externalImported = imported.filter((item) => !item.is_internal);
  if (externalImported.length === 1) {
    notification("success", `${noteLabel(externalImported[0].file_name)} se importó correctamente`);
  } else if (externalImported.length > 1) {
    notification(
      "success",
      `Se importaron ${externalImported.length} archivos (abriendo ${noteLabel(firstItem.file_name)})`,
    );
  }

  return finish();
}

/**
 * Legacy wrapper kept for existing callers/tests.
 * Resolves true iff the job imported at least one file.
 */
export async function handleExternalFileImport(paths: string[]): Promise<boolean> {
  if (!paths || paths.length === 0) return false;
  const handle = enqueueExternalFileImport(paths);
  const outcome = await handle.promise;
  return outcome.status !== "rejected" && outcome.imported.length > 0;
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
        void enqueueExternalFileImport(event.payload).promise;
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
        void enqueueExternalFileImport(pending).promise;
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

