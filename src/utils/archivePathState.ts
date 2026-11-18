export function isPathInArchivedFolder(path: string, archivedFolders: readonly string[]): boolean {
  return archivedFolders.some(folder => path === folder || path.startsWith(`${folder}/`));
}

export function hasArchivedAncestor(path: string, archivedFolders: readonly string[]): boolean {
  if (!path) return false;
  return archivedFolders.some(folder => path.startsWith(`${folder}/`));
}

export function isExplicitlyArchivedFolder(path: string, archivedFolders: readonly string[]): boolean {
  return archivedFolders.includes(path);
}

export type ArchivedFolderKind = "explicit" | "inherited" | "structural";

/**
 * Classification for folders visible in the archived view.
 * - explicit: folder identity is explicitly archived.
 * - inherited: folder is inside an explicitly archived ancestor (effectively archived).
 * - structural: active container shown only to reveal archived descendants.
 */
export function classifyArchivedViewFolder(path: string, archivedFolders: readonly string[]): ArchivedFolderKind {
  if (isExplicitlyArchivedFolder(path, archivedFolders)) return "explicit";
  if (hasArchivedAncestor(path, archivedFolders)) return "inherited";
  return "structural";
}
