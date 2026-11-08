import { normalizeText } from "./editorSyncCoordinator.ts";
import { contentHash, type DraftDiskPayload } from "./draftStore.ts";

export interface DraftPayload {
  content: string;
  updatedAt: number;
}

/**
 * Determina si dos contenidos de texto son idénticos normalizando únicamente
 * finales de línea (\r\n vs \n). NO ignora espacios finales para preservar
 * saltos de línea estrictos de Markdown (doble espacio) y sangrías del usuario.
 */
export function isContentEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  return normA === normB;
}

/**
 * Genera un nombre de archivo seguro y único para la copia de rescate del borrador.
 */
export function generateDraftRecoveryFileName(
  originalFileName: string,
  dateTag?: string,
  counter?: number
): string {
  const tag = dateTag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dotIdx = originalFileName.lastIndexOf(".");
  const stem = dotIdx !== -1 ? originalFileName.slice(0, dotIdx) : originalFileName;
  const ext = dotIdx !== -1 ? originalFileName.slice(dotIdx) : ".txt";
  const suffix = counter && counter > 0 ? ` (${counter})` : "";
  return `${stem} (borrador recuperado ${tag})${suffix}${ext}`;
}

export async function resolveUniqueDraftRecoveryFileName(
  originalFileName: string,
  checkExists: (name: string) => Promise<boolean>,
  dateTag?: string
): Promise<string> {
  const fixedTag = dateTag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = generateDraftRecoveryFileName(originalFileName, fixedTag);
  if (!(await checkExists(baseName))) {
    return baseName;
  }

  let counter = 1;
  while (counter < 1000) {
    const candidateName = generateDraftRecoveryFileName(originalFileName, fixedTag, counter);
    if (!(await checkExists(candidateName))) {
      return candidateName;
    }
    counter++;
  }
  return generateDraftRecoveryFileName(originalFileName, fixedTag, counter);
}

/**
 * Escribe de forma atómica y exclusiva una copia de rescate del borrador.
 * Si ocurre una colisión concurrente con otro proceso o pestaña, reintenta
 * secuencialmente con sufijos (1), (2), etc., garantizando exclusividad y evitando
 * cualquier sobrescritura accidental.
 */
export async function writeUniqueRecoveryFile(
  originalFileName: string,
  content: string,
  saveExclusive: (name: string, content: string) => Promise<void>,
  fileExists: (name: string) => Promise<boolean>,
  dateTag?: string
): Promise<string> {
  const fixedTag = dateTag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let counter = 0;

  while (counter < 1000) {
    const candidateName = generateDraftRecoveryFileName(
      originalFileName,
      fixedTag,
      counter === 0 ? undefined : counter
    );

    if (await fileExists(candidateName)) {
      counter++;
      continue;
    }

    try {
      await saveExclusive(candidateName, content);
      return candidateName;
    } catch (err) {
      const errStr = String(err).toLowerCase();
      if (
        errStr.includes("exist") ||
        errStr.includes("already") ||
        errStr.includes("os error 17")
      ) {
        counter++;
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    "No se pudo generar un nombre único exclusivo para la copia de rescate tras 1000 intentos"
  );
}

export interface ReconcileDraftParams {
  fileName: string;
  diskContent: string;
  draft: DraftPayload | null;
  /** Respaldo en .drafts/ (con revisión y baseHash). Si existe, tiene autoridad
   *  sobre heurísticas de updatedAt del borrador legacy en localStorage. */
  diskDraft?: DraftDiskPayload | null;
  diskMtime: number | null;
  saveFile: (name: string, content: string) => Promise<void>;
  readFile: (name: string) => Promise<string>;
  fileExists: (name: string) => Promise<boolean>;
  clearDraft: (name: string) => void;
  onConflictCreated?: (conflictName: string) => void;
  onConflictError?: (error: unknown) => void;
  dateTag?: string;
}

export interface ReconcileDraftResult {
  action: "use_disk" | "use_draft" | "conflict_created" | "conflict_failed";
  contentToLoad: string;
  conflictFileName?: string;
  draftCleared: boolean;
}

/**
 * Reconcilia el estado entre el contenido de disco y el borrador local en localStorage.
 * Garantiza que NUNCA se descarte silenciosamente un borrador no guardado si el disco
 * fue modificado posteriormente con contenido diferente.
 */
export async function reconcileDraftState(params: ReconcileDraftParams): Promise<ReconcileDraftResult> {
  const {
    fileName,
    diskContent,
    draft,
    diskDraft,
    diskMtime,
    saveFile,
    readFile,
    fileExists,
    clearDraft,
    onConflictCreated,
    onConflictError,
    dateTag,
  } = params;

  // 0. Candidatos: respaldo en disco (con revisión) o legacy localStorage.
  // Si hay disco, manda por revisión; si no, queda el legacy con updatedAt.
  const hasDiskDraft = Boolean(diskDraft);
  const effectiveDraft: DraftPayload | null = diskDraft
    ? { content: diskDraft.content, updatedAt: diskDraft.updatedAt }
    : draft;

  // 1. Si no hay borrador, cargar disco directamente
  if (!effectiveDraft) {
    return {
      action: "use_disk",
      contentToLoad: diskContent,
      draftCleared: false,
    };
  }

  // 2. Si el contenido del borrador es idéntico al de disco (normalizando CRLF a LF)
  if (isContentEquivalent(diskContent, effectiveDraft.content)) {
    clearDraft(fileName);
    return {
      action: "use_disk",
      contentToLoad: diskContent,
      draftCleared: true,
    };
  }

  // 3. Respaldo con revisión: obsoleto (crash tras guardado canónico) o canónico avanzado.
  if (hasDiskDraft && diskDraft) {
    // Borrador ya guardado canónicamente y luego interrumpido antes de limpiar.
    if (diskDraft.revision <= diskDraft.lastSavedRevision) {
      clearDraft(fileName);
      return {
        action: "use_disk",
        contentToLoad: diskContent,
        draftCleared: true,
      };
    }
    // El canónico cambió respecto de la base del borrador: nunca auto-aplicar.
    // Ir a rescate por copia verificada (paso 5).
    if (diskDraft.baseHash !== contentHash(diskContent)) {
      // Los contenidos difieren y la base no coincide: rescate directo.
    } else {
      // Revisión viva sobre la misma base: usar borrador.
      return {
        action: "use_draft",
        contentToLoad: effectiveDraft.content,
        draftCleared: false,
      };
    }
  } else if (effectiveDraft) {
    // Legacy sin respaldo en disco: heurística updatedAt (sin cambios).
    // Si no se puede obtener diskMtime o el borrador es más reciente o concurrente
    // (con 1s de margen de tolerancia), el borrador es más reciente.
    const isDiskNewer = diskMtime !== null && diskMtime > effectiveDraft.updatedAt + 1000;
    if (!isDiskNewer) {
      return {
        action: "use_draft",
        contentToLoad: effectiveDraft.content,
        draftCleared: false,
      };
    }
    // De lo contrario (disco posterior), caer al rescate por copia.
  }

  // 4. El disco es posterior y los contenidos difieren:
  // Crear copia de rescate exclusiva del borrador sin borrarlo de localStorage hasta verificar la persistencia
  try {
    const recoveryFileName = await writeUniqueRecoveryFile(
      fileName,
      effectiveDraft.content,
      saveFile,
      fileExists,
      dateTag
    );

    // Verificación de lectura obligatoria
    const readBack = await readFile(recoveryFileName);
    if (!isContentEquivalent(readBack, effectiveDraft.content)) {
      throw new Error(
        `Fallo de verificación de integridad al escribir copia de rescate '${recoveryFileName}'`
      );
    }

    // ÚNICAMENTE tras verificar la escritura física en disco se descarta el borrador de localStorage
    clearDraft(fileName);
    onConflictCreated?.(recoveryFileName);

    return {
      action: "conflict_created",
      contentToLoad: diskContent,
      conflictFileName: recoveryFileName,
      draftCleared: true,
    };
  } catch (error) {
    // Si falla la escritura o verificación, el borrador PERMANECE intacto en localStorage
    onConflictError?.(error);
    return {
      action: "conflict_failed",
      contentToLoad: effectiveDraft.content,
      draftCleared: false,
    };
  }
}
