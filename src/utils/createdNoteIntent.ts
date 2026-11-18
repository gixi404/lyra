import type { ListViewMode } from "./listScroll.ts";
import { expandAncestorsForNote, parseFolderExpandedState } from "./folderTree.ts";
import { getFileDirectory } from "./noteName.ts";

export interface CreatedNoteIntent {
  fileName: string;
  view: ListViewMode;
}

let pendingIntent: CreatedNoteIntent | null = null;

export function setCreatedNoteIntent(fileName: string, view: ListViewMode): void {
  pendingIntent = { fileName, view };
}

export function getCreatedNoteIntent(): CreatedNoteIntent | null {
  return pendingIntent;
}

export function expandCreatedNoteOnReturn(
  storage: Pick<Storage, "getItem">,
  persist: (expanded: string) => void,
): boolean {
  if (!pendingIntent || pendingIntent.view !== "active") return false;
  const current = parseFolderExpandedState(storage.getItem("folderExpanded"));
  const next = expandAncestorsForNote(current, getFileDirectory(pendingIntent.fileName));
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  persist(JSON.stringify(next));
  return true;
}

export function consumeCreatedNoteIntent(fileName?: string): CreatedNoteIntent | null {
  if (!pendingIntent) return null;
  if (fileName && pendingIntent.fileName !== fileName) return null;
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}

// Nota: la intención se mantiene hasta poder mostrar la nota (o hasta ser reemplazada/limpiada explícitamente).
// No se descarta solo porque el listado en memoria aún no incluya la nota recién creada.

export function clearCreatedNoteIntent(): void {
  pendingIntent = null;
}
