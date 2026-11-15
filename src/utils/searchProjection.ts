import { ROOT_FOLDER_ID } from "./folderTree.ts";
import { getFileDirectory } from "./noteName.ts";

/**
 * Devuelve todos los directorios antecesores de una nota, de más externo a más interno.
 * Ej.: "A/B/C/nota.txt" -> ["A", "A/B", "A/B/C"]; "nota.txt" -> []
 */
export function getNoteAncestorFolders(filePath: string): string[] {
  const dir = getFileDirectory(filePath);
  if (!dir) return [];
  const parts = dir.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    ancestors.push(parts.slice(0, i).join("/"));
  }
  return ancestors;
}

/** Conjunto de carpetas necesarias para acceder a las notas indicadas (incluye todos sus antecesores). */
export function getNecessaryFolderPaths(matchingFiles: readonly string[]): Set<string> {
  const needed = new Set<string>();
  for (const file of matchingFiles) {
    for (const ancestor of getNoteAncestorFolders(file)) {
      needed.add(ancestor);
    }
  }
  return needed;
}

/**
 * Expansión forzada durante una búsqueda: abre todos los antecesores de las notas coincidentes
 * y, si hay coincidencias en la raíz y se muestra la fila raíz, expande Lyra.
 */
export function getForcedExpandedForSearch(
  matchingFiles: readonly string[],
  showRoot: boolean,
): Record<string, boolean> {
  const forced: Record<string, boolean> = {};
  for (const file of matchingFiles) {
    const dir = getFileDirectory(file);
    if (!dir) {
      if (showRoot) forced[ROOT_FOLDER_ID] = true;
      continue;
    }
    for (const ancestor of getNoteAncestorFolders(file)) {
      forced[ancestor] = true;
    }
  }
  return forced;
}
