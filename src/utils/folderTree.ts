import { getFileDirectory } from "./noteName.ts";
import { displayFolderName } from "./visibleNames.ts";

export const ROOT_FOLDER_ID = "root:lyra";

export interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  files: string[];
}

export type FolderOrder = Record<string, string[]>;

export function buildFolderTree(
  folderPaths: string[],
  files: string[],
  order: FolderOrder = {},
  fileOrder?: FolderOrder,
): FolderNode {
  const root: FolderNode = { path: "", name: displayFolderName(""), folders: [], files: [] };
  const nodes = new Map<string, FolderNode>([["", root]]);
  for (const path of [...folderPaths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    if (!path || nodes.has(path)) continue;
    const parentPath = getFileDirectory(path);
    const parent = nodes.get(parentPath);
    if (!parent) continue;
    const node: FolderNode = { path, name: displayFolderName(path), folders: [], files: [] };
    nodes.set(path, node);
    parent.folders.push(node);
  }
  for (const file of files) nodes.get(getFileDirectory(file))?.files.push(file);
  for (const node of nodes.values()) {
    const positions = new Map((order[node.path] ?? []).map((path, index) => [path, index]));
    node.folders.sort((a, b) => (positions.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.path) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    if (fileOrder) {
      const filePositions = new Map((fileOrder[node.path] ?? []).map((path, index) => [path, index]));
      // Estable: sin posición manual conservan el orden de entrada (relativo).
      node.files.sort((a, b) => (filePositions.get(a) ?? Number.MAX_SAFE_INTEGER) - (filePositions.get(b) ?? Number.MAX_SAFE_INTEGER));
    }
  }
  return root;
}

/** Reordena `moving` al índice que ocupa `target` en `paths` (arrayMove clásico).
 *  Solo toca la lista de orden; nunca el disco. Devuelve `order` sin cambios
 *  si la operación no es aplicable. */
export function reorderEntries(order: FolderOrder, parentPath: string, paths: string[], moving: string, target: string): FolderOrder {
  if (moving === target || !paths.includes(moving) || !paths.includes(target)) return order;
  const insertAt = paths.indexOf(target);
  const next = paths.filter(path => path !== moving);
  next.splice(insertAt, 0, moving);
  return { ...order, [parentPath]: next };
}

export function reorderFolder(order: FolderOrder, parentPath: string, paths: string[], moving: string, target: string, _after: boolean): FolderOrder {
  return reorderEntries(order, parentPath, paths, moving, target);
}

/** Inserta (o reubica) una entrada en la lista manual de su padre, en el índice dado. */
export function insertEntry(order: FolderOrder, parentPath: string, entry: string, index?: number): FolderOrder {
  const current = order[parentPath] ?? [];
  const next = current.filter(path => path !== entry);
  const at = index === undefined ? next.length : Math.max(0, Math.min(index, next.length));
  next.splice(at, 0, entry);
  return { ...order, [parentPath]: next };
}

/** Reubica una entrada que cambia de ruta (renombrar/mover) en todas las listas, o la elimina de su origen. */
export function relocateEntry(order: FolderOrder, change: { oldPath: string; newPath: string }): FolderOrder {
  const newParent = getFileDirectory(change.newPath);
  const oldParent = getFileDirectory(change.oldPath);
  const next: FolderOrder = {};
  for (const [parent, entries] of Object.entries(order)) {
    if (!Array.isArray(entries)) continue;
    next[parent] = entries.filter(path => path !== change.oldPath);
  }
  const index = (order[oldParent] ?? []).indexOf(change.oldPath);
  const dest = (next[newParent] ?? []).filter(path => path !== change.newPath);
  if (index !== -1) {
    if (newParent === oldParent) {
      // Renombrado en el mismo padre: conservar el índice; si no estaba en la lista, no se inserta.
      dest.splice(Math.min(index, dest.length), 0, change.newPath);
    } else {
      // Cruce de carpeta: va al final del destino; la posición exacta la fija quien orquesta el movimiento.
      dest.push(change.newPath);
    }
    next[newParent] = dest;
  }
  return next;
}

export function expandFolderAncestors(current: Record<string, boolean>, path: string): Record<string, boolean> {
  const next: Record<string, boolean> = { ...current, [ROOT_FOLDER_ID]: true };
  if (path) {
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) next[parts.slice(0, index).join("/")] = true;
  }
  return next;
}

/**
 * Expande el padre y sus ancestros para revelar una subcarpeta recién creada.
 * No modifica el estado de expansión de "Lyra" (raíz) para no desplegarla
 * innecesariamente al crear carpetas de primer nivel.
 */
export function expandParentPath(current: Record<string, boolean>, parentPath: string): Record<string, boolean> {
  if (!parentPath) return current;
  const next: Record<string, boolean> = { ...current };
  const parts = parentPath.split("/");
  for (let index = 1; index <= parts.length; index++) next[parts.slice(0, index).join("/")] = true;
  return next;
}

/**
 * Expande los ancestros necesarios para revelar una nota recién creada.
 * - Nota en raíz: despliega "Lyra".
 * - Nota en carpeta/subcarpeta: despliega esa carpeta y sus ancestros sin forzar Lyra.
 */
export function expandAncestorsForNote(current: Record<string, boolean>, folderPath: string): Record<string, boolean> {
  if (!folderPath) return { ...current, [ROOT_FOLDER_ID]: true };
  return expandParentPath(current, folderPath);
}

export function remapPath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
}

export function defaultFolderExpandedState(): Record<string, boolean> {
  return { [ROOT_FOLDER_ID]: true };
}

export function parseFolderExpandedState(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return defaultFolderExpandedState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaultFolderExpandedState();
    }
    return parsed as Record<string, boolean>;
  } catch {
    return defaultFolderExpandedState();
  }
}

export function readFolderExpandedState(storage: Pick<Storage, "getItem">): Record<string, boolean> {
  return parseFolderExpandedState(storage.getItem("folderExpanded"));
}
