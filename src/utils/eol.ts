/**
 * eol.ts - Motor integral de detección, normalización y preservación de saltos de línea (EOL) y BOM
 * para Lyra (EDITOR-004).
 *
 * Principio rector:
 * El editor opera 100% con LF (\n) internamente (estado, textarea, índices, selección, párrafos,
 * búsqueda, spellcheck e historial).
 * La conversión al formato físico correspondiente se realiza exclusivamente en los límites
 * de persistencia (guardado a disco, exportación).
 */

export type EOLType = "lf" | "crlf" | "cr";
export type EOLFormat = EOLType | "mixed" | "none";

export interface EOLMetadata {
  format: EOLFormat;
  dominant: EOLType;
  counts: {
    lf: number;
    crlf: number;
    cr: number;
  };
  tieBreakerFirstSeen?: EOLType;
  hasBOM: boolean;
}

export interface NoteEOLRecord {
  metadata: EOLMetadata;
  rawOriginal: string;
}

/**
 * Escanea un texto y detecta con precisión el formato de saltos de línea (EOL) y BOM.
 * Es determinista y de complejidad O(N) en una sola pasada.
 */
export function detectEOL(rawText: string): EOLMetadata {
  const hasBOM = rawText.startsWith("\uFEFF");
  const text = hasBOM ? rawText.slice(1) : rawText;

  let crlf = 0;
  let lf = 0;
  let cr = 0;
  let tieBreakerFirstSeen: EOLType | undefined = undefined;

  const len = text.length;
  for (let i = 0; i < len; i++) {
    const char = text[i];
    if (char === "\r") {
      if (i + 1 < len && text[i + 1] === "\n") {
        crlf++;
        if (!tieBreakerFirstSeen) tieBreakerFirstSeen = "crlf";
        i++; // saltar el '\n' de CRLF
      } else {
        cr++;
        if (!tieBreakerFirstSeen) tieBreakerFirstSeen = "cr";
      }
    } else if (char === "\n") {
      lf++;
      if (!tieBreakerFirstSeen) tieBreakerFirstSeen = "lf";
    }
  }

  const counts = { lf, crlf, cr };
  const total = lf + crlf + cr;

  if (total === 0) {
    return {
      format: "none",
      dominant: "lf",
      counts,
      hasBOM,
    };
  }

  const typesPresent = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);

  if (typesPresent === 1) {
    const format: EOLType = crlf > 0 ? "crlf" : cr > 0 ? "cr" : "lf";
    return {
      format,
      dominant: format,
      counts,
      tieBreakerFirstSeen,
      hasBOM,
    };
  }

  // Archivo mixto: resolver 'dominant'
  // Regla: "En caso de empate entre formatos, utiliza el primero que aparece en el archivo original."
  let dominant: EOLType = "lf";
  let maxCount = -1;

  const order: EOLType[] = tieBreakerFirstSeen
    ? [tieBreakerFirstSeen, ...((["lf", "crlf", "cr"] as EOLType[]).filter(t => t !== tieBreakerFirstSeen))]
    : ["lf", "crlf", "cr"];

  for (const t of order) {
    const count = counts[t];
    if (count > maxCount) {
      maxCount = count;
      dominant = t;
    }
  }

  return {
    format: "mixed",
    dominant,
    counts,
    tieBreakerFirstSeen,
    hasBOM,
  };
}

/**
 * Normaliza cualquier texto a LF (\n) y remueve el BOM inicial (si existe)
 * para el consumo exclusivo interno del editor.
 */
export function normalizeToLF(rawText: string): { text: string; metadata: EOLMetadata } {
  const metadata = detectEOL(rawText);
  let text = metadata.hasBOM ? rawText.slice(1) : rawText;

  if (metadata.format === "lf") {
    return { text, metadata };
  }

  // Reemplazar CRLF por LF, y luego CR solitarios por LF
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { text, metadata };
}

/**
 * Re-serializa un texto lógico (LF) a su representación física esperada según la metadata EOL.
 * Implementa la Estrategia C:
 * - Si no existen modificaciones efectivas (hasEdits === false) y se suministra rawOriginal,
 *   devuelve exactamente rawOriginal sin alterar un solo byte.
 * - Si existen modificaciones:
 *   * Homogéneo LF: devuelve LF.
 *   * Homogéneo CRLF: convierte \n a \r\n.
 *   * Homogéneo CR: convierte \n a \r.
 *   * Sin saltos (none): devuelve LF para cualquier salto nuevo.
 *   * Mixto: utiliza metadata.dominant (con desempate por tieBreakerFirstSeen).
 *   * Si hasBOM: antepone \uFEFF.
 */
export function denormalizeEOL(
  logicalText: string,
  metadata?: EOLMetadata | null,
  options?: {
    hasEdits?: boolean;
    rawOriginal?: string;
  }
): string {
  // Garantía 1: Sin modificaciones efectivas, preservar exactamente el original físico
  if (options?.hasEdits === false && options?.rawOriginal !== undefined) {
    return options.rawOriginal;
  }

  if (!metadata) {
    return logicalText;
  }

  let target: EOLType;
  if (metadata.format === "crlf") {
    target = "crlf";
  } else if (metadata.format === "cr") {
    target = "cr";
  } else if (metadata.format === "lf" || metadata.format === "none") {
    target = "lf";
  } else {
    // Mixto: usar formato dominante
    target = metadata.dominant;
  }

  let result = logicalText;
  if (target === "crlf") {
    result = logicalText.replace(/\n/g, "\r\n");
  } else if (target === "cr") {
    result = logicalText.replace(/\n/g, "\r");
  }

  if (metadata.hasBOM) {
    result = "\uFEFF" + result;
  }

  return result;
}

// Registro en memoria de EOL vinculado a la identidad física y ruta de notas
const eolRegistryByIdentity = new Map<string, NoteEOLRecord>();
const eolRegistryByPath = new Map<string, NoteEOLRecord>();

export function registerNoteEOL(
  identity: string | undefined,
  path: string,
  metadata: EOLMetadata,
  rawOriginal: string
): void {
  const record: NoteEOLRecord = { metadata, rawOriginal };
  if (identity) {
    eolRegistryByIdentity.set(identity, record);
  }
  eolRegistryByPath.set(path, record);
}

export function getNoteEOL(identity: string | undefined, path: string): NoteEOLRecord | undefined {
  if (identity && eolRegistryByIdentity.has(identity)) {
    return eolRegistryByIdentity.get(identity);
  }
  return eolRegistryByPath.get(path);
}

export function updateNoteEOL(
  identity: string | undefined,
  path: string,
  newRawPhysical: string
): void {
  const meta = detectEOL(newRawPhysical);
  registerNoteEOL(identity, path, meta, newRawPhysical);
}

export function remapNoteEOL(oldPath: string, newPath: string, identity?: string): void {
  const record = getNoteEOL(identity, oldPath);
  if (record) {
    eolRegistryByPath.delete(oldPath);
    eolRegistryByPath.set(newPath, record);
  }
}

export function clearNoteEOL(path: string, identity?: string): void {
  if (identity) {
    eolRegistryByIdentity.delete(identity);
  }
  eolRegistryByPath.delete(path);
}

export function __resetEOLRegistryForTests(): void {
  eolRegistryByIdentity.clear();
  eolRegistryByPath.clear();
}
