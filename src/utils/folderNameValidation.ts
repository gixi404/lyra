import translations from "./dictionary.ts";
import { isReservedWindowsFileName } from "./noteName.ts";

const FORBIDDEN_FOLDER_NAME_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];

export interface FolderNameValidation {
  ok: boolean;
  reason?: string;
}

export function validateFolderName(name: string): FolderNameValidation {
  const d = translations();
  if (!name || name.trim().length === 0) {
    return { ok: false, reason: d.FolderNameEmpty ?? "El nombre de la carpeta no puede estar vacío." };
  }
  if (name !== name.trim()) {
    return { ok: false, reason: d.FolderNameEdgeSpaces ?? "El nombre de la carpeta no puede empezar ni terminar con espacios." };
  }
  if ([...name].some(c => c.charCodeAt(0) <= 31)) {
    return { ok: false, reason: d.FolderNameControlChars ?? "El nombre de la carpeta contiene caracteres de control no permitidos." };
  }
  if (FORBIDDEN_FOLDER_NAME_CHARS.some(c => name.includes(c))) {
    return { ok: false, reason: d.FolderNameInvalidChars ?? "El nombre de la carpeta contiene caracteres no permitidos." };
  }
  if (/^[ .]|[ .]$/.test(name)) {
    return { ok: false, reason: d.FolderNameEdgeDotsSpaces ?? "El nombre de la carpeta no puede empezar ni terminar con puntos o espacios." };
  }
  if (name.length > 60) {
    return { ok: false, reason: d.FolderNameTooLong ?? "El nombre de la carpeta es demasiado largo (máximo 60 caracteres)." };
  }
  if (isReservedWindowsFileName(name)) {
    return { ok: false, reason: d.FolderNameReservedWindows ?? "Ese nombre está reservado por Windows y no se puede usar." };
  }
  return { ok: true };
}
