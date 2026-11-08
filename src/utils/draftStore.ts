import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger.ts";

/** M9 — Respaldo persistente de borradores con cola por nota y estado observable. */

export interface DraftDiskPayload {
  v: 1;
  noteName: string;
  draftId: string;
  revision: number;
  baseHash: string;
  content: string;
  lastSavedRevision: number;
  lastSavedHash: string;
  updatedAt: number;
}

export type DraftProtection =
  | "idle" // sin cambios sin proteger
  | "protected_ls" // localStorage confirmado
  | "protected_disk" // disco confirmado
  | "pending" // backup asíncrono en curso
  | "unprotected"; // ni LS ni disco confirmados

/** Límite orientativo: payloads mayores que esto van directos a disco. */
export const DRAFT_LOCALSTORAGE_CAP_BYTES = 1024 * 1024;

/** FNV-1a 64-bit en hex (16 chars). Estable, síncrono, sin colisiones prácticas
 *  para el set de rutas de notas de un usuario. */
export function draftIdFor(noteName: string): string {
  const key = noteName.normalize("NFC").trim();
  let h = 0xcbf29ce484222325n;
  const enc = new TextEncoder().encode(key);
  for (const b of enc) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Hash de contenido (FNV-1a 64, mismo que draftId). Base para baseHash/lastSavedHash. */
export function contentHash(content: string): string {
  return draftIdFor(content);
}

const queues = new Map<string, Promise<void>>();
const clearedRevision = new Map<string, number>();
const generations = new Map<string, number>();
const lastKnownContent = new Map<string, string>();
const lastWriteSucceeded = new Map<string, boolean>();
const revisions = new Map<string, number>();
const baseHashes = new Map<string, string>();
const readyPromises = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

let protection: DraftProtection = "idle";

function setProtection(next: DraftProtection): void {
  protection = next;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* listener errors are not fatal */
    }
  }
}

export function getDraftProtection(): DraftProtection {
  return protection;
}

export function subscribeDraftProtection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function enqueue<T>(draftId: string, op: () => Promise<T>): Promise<T> {
  const prior = queues.get(draftId) ?? Promise.resolve();
  const next = prior.then(op, op);
  queues.set(
    draftId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function byteLength(content: string): number {
  try {
    return new TextEncoder().encode(content).length;
  } catch {
    return content.length * 2;
  }
}

function draftKey(noteName: string): string {
  return `lyra-draft:${noteName}`;
}

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__)
  );
}

async function saveDraftDisk(payload: DraftDiskPayload): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_draft_file", {
    draftId: payload.draftId,
    payloadJson: JSON.stringify(payload),
  });
}

async function deleteDraftDisk(draftId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_draft_file", { draftId });
}

export async function readDraftDisk(noteName: string): Promise<DraftDiskPayload | null> {
  if (!isTauri()) return null;
  const draftId = draftIdFor(noteName);
  const raw = await invoke<string | null>("read_draft_file", { draftId });
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as DraftDiskPayload;
    if (
      parsed?.v !== 1 ||
      typeof parsed.content !== "string" ||
      typeof parsed.revision !== "number" ||
      typeof parsed.baseHash !== "string" ||
      parsed.draftId !== draftId
    ) {
      logger.warn(`[draftStore] Borrador en disco corrupto para ${noteName}; se conserva sin uso.`);
      return null;
    }
    return parsed;
  } catch {
    logger.warn(`[draftStore] Borrador en disco corrupto (JSON) para ${noteName}; se conserva sin uso.`);
    return null;
  }
}

/**
 * Semilla de revisiones desde disco (una vez por nota y sesión).
 * Captura la generación al iniciar y la recheckea tras cada esperada
 * (lectura de disco): si hubo clear/rename/delete, descarta sin mutar.
 * Se ejecuta directamente (no en cola) para no deadlokear writes.
 */
export function seedDraftRevision(noteName: string, baseContent?: string): Promise<void> {
  const draftId = draftIdFor(noteName);
  const existing = readyPromises.get(draftId);
  if (existing) return existing;
  const capturedGeneration = currentGeneration(draftId);
  const seed = (async () => {
    try {
      const disk = await readDraftDisk(noteName);
      if (capturedGeneration !== currentGeneration(draftId)) return;
      if (disk) {
        revisions.set(draftId, Math.max(revisions.get(draftId) ?? 0, disk.revision));
        if (disk.baseHash) baseHashes.set(draftId, disk.baseHash);
      }
    } catch (err) {
      logger.warn(`[draftStore] No se pudo sembrar revisión de ${noteName}:`, err);
      return;
    }
    if (capturedGeneration !== currentGeneration(draftId)) return;
    if (baseContent !== undefined && !baseHashes.has(draftId)) {
      baseHashes.set(draftId, contentHash(baseContent));
    }
  })();
  readyPromises.set(draftId, seed.then(() => undefined, () => undefined));
  return seed;
}

function currentGeneration(draftId: string): number {
  return generations.get(draftId) ?? 0;
}

function nextGeneration(draftId: string): number {
  const g = currentGeneration(draftId) + 1;
  generations.set(draftId, g);
  return g;
}

/** Escritura síncrona best-effort para beforeunload (solo LS). Nunca lanza. */
export function flushDraftSync(noteName: string, content: string): boolean {
  if (!noteName) return false;
  try {
    window.localStorage.setItem(
      draftKey(noteName),
      JSON.stringify({ content, updatedAt: Date.now() }),
    );
    setProtection("protected_ls");
    return true;
  } catch (err) {
    logger.warn(`[draftStore] flushDraftSync en localStorage falló para ${noteName}:`, err);
    setProtection("pending");
    void writeDraftDisk(noteName, content);
    return false;
  }
}

async function writeDraftDisk(noteName: string, content: string): Promise<void> {
  const draftId = draftIdFor(noteName);
  lastKnownContent.set(draftId, content);
  const capturedGeneration = currentGeneration(draftId);
  return enqueue(draftId, async () => {
    await seedDraftRevision(noteName);
    if (capturedGeneration !== currentGeneration(draftId)) {
      // Generación avanzada por clear/rename/delete posterior al enqueue.
      return;
    }
    const revision = (revisions.get(draftId) ?? 0) + 1;
    // "" = base desconocida -> recuperación conservadora (rescate), nunca auto-apply.
    const baseHash = baseHashes.get(draftId) ?? "";
    const payload: DraftDiskPayload = {
      v: 1,
      noteName,
      draftId,
      revision,
      baseHash,
      content,
      lastSavedRevision: clearedRevision.get(draftId) ?? 0,
      lastSavedHash: baseHash,
      updatedAt: Date.now(),
    };
    if (revision <= (clearedRevision.get(draftId) ?? 0)) {
      // Escritura tardía tras clear: descartar (Riesgo B).
      return;
    }
    try {
      await saveDraftDisk(payload);
      revisions.set(draftId, revision);
      lastWriteSucceeded.set(draftId, true);
      setProtection("protected_disk");
    } catch (err) {
      logger.warn(`[draftStore] Respaldo en disco falló para ${noteName}:`, err);
      lastWriteSucceeded.set(draftId, false);
      setProtection("unprotected");
    }
  });
}

/**
 * Punto de entrada compatible con EditorSyncCoordinator (síncrono, nunca lanza).
 * Intenta LS primero; si falla o el payload excede el cap, cae a disco en cola.
 */
export function writeDraft(noteName: string, draftContent: string): void {
  if (!noteName) return;
  const draftId = draftIdFor(noteName);
  lastKnownContent.set(draftId, draftContent);
  const overCap = byteLength(draftContent) > DRAFT_LOCALSTORAGE_CAP_BYTES;
  if (!overCap) {
    try {
      window.localStorage.setItem(
        draftKey(noteName),
        JSON.stringify({ content: draftContent, updatedAt: Date.now() }),
      );
      setProtection("protected_ls");
      return;
    } catch (err) {
      logger.warn(`[draftStore] localStorage falló para ${noteName}:`, err);
    }
  }
  setProtection("pending");
  void writeDraftDisk(noteName, draftContent);
}

/**
 * Autoridad persistente (M9-4/5): tras confirmar el guardado canónico, avanza
 * `lastSavedRevision`/`lastSavedHash` solo hasta `savedRevision` (el snapshot
 * confirmado), nunca hasta una revisión posterior mutable.
 * Dos pasos: (1) escribe el estado avanzado, (2) borra si no hay revisión
 * posterior pendiente. Un cierre entre ambos deja `revision <= lastSavedRevision`.
 */
export function markDraftSaved(noteName: string, savedContent: string, savedRevision: number): void {
  if (!noteName) return;
  const draftId = draftIdFor(noteName);
  const capturedGeneration = currentGeneration(draftId);
  void enqueue(draftId, async () => {
    await seedDraftRevision(noteName);
    if (capturedGeneration !== currentGeneration(draftId)) return;
    if (savedRevision < (clearedRevision.get(draftId) ?? 0)) return;
    const savedHash = savedContent ? contentHash(savedContent) : (baseHashes.get(draftId) ?? "");
    const existing = await readDraftDisk(noteName);
    if (existing && existing.revision > savedRevision) {
      // Hay revisión posterior (B) pendiente: no borrarla; solo avanzar
      // su estado base hacia el nuevo canónico, sin regresión.
      const payload: DraftDiskPayload = {
        ...existing,
        baseHash: savedHash,
        lastSavedRevision: Math.max(existing.lastSavedRevision, savedRevision),
        lastSavedHash: savedHash,
        updatedAt: Date.now(),
      };
      clearedRevision.set(draftId, Math.max(clearedRevision.get(draftId) ?? 0, savedRevision));
      baseHashes.set(draftId, savedHash);
      try {
        await saveDraftDisk(payload);
      } catch (err) {
        logger.warn(`[draftStore] No se pudo actualizar estado guardado de ${noteName}:`, err);
      }
      return;
    }
    clearedRevision.set(draftId, Math.max(clearedRevision.get(draftId) ?? 0, savedRevision));
    baseHashes.set(draftId, savedHash);
    const payload: DraftDiskPayload = {
      v: 1,
      noteName,
      draftId,
      revision: savedRevision,
      baseHash: savedHash,
      content: savedContent,
      lastSavedRevision: clearedRevision.get(draftId) ?? 0,
      lastSavedHash: savedHash,
      updatedAt: Date.now(),
    };
    try {
      await saveDraftDisk(payload);
    } catch (err) {
      logger.warn(`[draftStore] No se pudo persistir estado guardado de ${noteName}:`, err);
    }
    try {
      await deleteDraftDisk(draftId);
    } catch (err) {
      logger.warn(`[draftStore] No se pudo eliminar respaldo de ${noteName}:`, err);
    }
  });
}

/**
 * Migra el respaldo en disco a una nueva identidad (rename).
 * Serializada en la cola del draftId anterior con barrera de generación:
 * un write previo pendiente se descarta en vez de recrear el respaldo viejo.
 */
export async function migrateDraftDisk(
  oldName: string,
  newName: string,
): Promise<{ migrated: boolean; keptOriginal: boolean; error?: string }> {
  if (!oldName || !newName || oldName === newName) return { migrated: false, keptOriginal: true };
  const oldId = draftIdFor(oldName);
  const newId = draftIdFor(newName);
  nextGeneration(oldId);
  readyPromises.delete(oldId);
  const capturedGeneration = currentGeneration(oldId);
  return enqueue(oldId, async () => {
    if (capturedGeneration !== currentGeneration(oldId)) {
      return { migrated: false, keptOriginal: true, error: "Generación avanzada (rename/clear concurrente)" };
    }
    const old = await readDraftDisk(oldName);
    if (!old) return { migrated: false, keptOriginal: true };
    try {
      await saveDraftDisk({ ...old, noteName: newName, draftId: newId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[draftStore] Migración de borrador falló para ${oldName} -> ${newName}: ${msg} (original conservado)`);
      return { migrated: false, keptOriginal: true, error: msg };
    }
    try {
      await deleteDraftDisk(oldId);
    } catch (err) {
      logger.warn(`[draftStore] No se pudo eliminar respaldo viejo de ${oldName}:`, err);
    }
    return { migrated: true, keptOriginal: false };
  }).then(
    (v) => v,
    (err: unknown) => ({
      migrated: false,
      keptOriginal: true,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/** Serializada con writeDraft por draftId: una escritura previa no recrea
 *  el borrador tras una eliminación (watermark de revisiones + generación). */
export function clearDraft(noteName: string): void {
  if (!noteName) return;
  const draftId = draftIdFor(noteName);
  nextGeneration(draftId);
  readyPromises.delete(draftId);
  try {
    window.localStorage.removeItem(draftKey(noteName));
  } catch {
    /* best-effort */
  }
  const watermark = revisions.get(draftId) ?? 0;
  clearedRevision.set(draftId, Math.max(clearedRevision.get(draftId) ?? 0, watermark));
  void enqueue(draftId, async () => {
    try {
      await deleteDraftDisk(draftId);
    } catch (err) {
      logger.warn(`[draftStore] No se pudo eliminar respaldo de ${noteName}:`, err);
    }
  });
}

/** Lectura síncrona legacy (LS) para el render inicial. No toca disco. */
export function readDraftLS(noteName: string): { content: string; updatedAt: number } | null {
  if (!noteName) return null;
  try {
    const raw = window.localStorage.getItem(draftKey(noteName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { content?: unknown; updatedAt?: unknown };
    if (typeof parsed.content !== "string" || typeof parsed.updatedAt !== "number") return null;
    return { content: parsed.content, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

/**
 * Async: espera la cola del draft (protección confirmada) y borra.
 * Devuelve true solo si los pendientes de disco se confirmaron
 * (o no había ninguno). Nunca valida por toast.
 */
export async function flushDraftAsync(noteName: string): Promise<boolean> {
  const draftId = draftIdFor(noteName);
  await (queues.get(draftId) ?? Promise.resolve());
  return lastWriteSucceeded.get(draftId) ?? true;
}

/** Solo tests: resetea estado entre casos. */
export function __resetDraftStoreForTests(): void {
  queues.clear();
  clearedRevision.clear();
  generations.clear();
  lastKnownContent.clear();
  revisions.clear();
  baseHashes.clear();
  readyPromises.clear();
  setProtection("idle");
}
