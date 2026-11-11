import { ROOT_FOLDER_ID, type FolderNode } from "./folderTree.ts";

export interface FlatRow {
  id: string; // "file:<path>" | "folder:<path>" | "folder:" (raíz Lyra)
  kind: "file" | "folder";
  path: string;
  depth: number;
  isRoot: boolean;
  /** false cuando algún ancestro está cerrado (la fila se colapsa a altura 0). */
  open: boolean;
}

/**
 * Aplana el árbol en filas ordenadas para el explorador.
 * La jerarquía de carpetas se expresa solo con `depth` (sangría) para que todas
 * las filas sean hermanas visibles dentro de un único Droppable.
 *
 * Todas las filas se renderizan siempre; las cerradas quedan con altura 0
 * (animación Motion de altura auto ↔ 0 por fila), conservando la expansión y
 * contracción animada de carpetas sin contenedores entre hermanos.
 *
 * - showRoot=true: la fila «Lyra» va primera; sus archivos como hijos (depth 1);
 *   las carpetas de primer nivel van como filas hermanas de nivel superior.
 * - showRoot=false (archivados): todo el árbol va plano desde depth 0.
 *
 * Las carpetas de primer nivel se ordenan con `order["$top"]`, igual que hace el
 * render actual del explorador.
 */
export function flattenVisible(tree: FolderNode, expanded: Record<string, boolean>, showRoot = true, folderOrder: Record<string, string[]> = {}): FlatRow[] {
  const topFolders = [...tree.folders].sort((a, b) => {
    const positions = new Map((folderOrder["$top"] ?? []).map((path, index) => [path, index]));
    return (positions.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.path) ?? Number.MAX_SAFE_INTEGER)
      || (a.path && b.path ? a.name.localeCompare(b.name) : a.path ? 1 : -1);
  });
  const rows: FlatRow[] = [];
  // Cada nivel emite carpetas primero y luego archivos (comportamiento vigente).
  const walk = (node: FolderNode, depth: number, open: boolean) => {
    for (const child of node.folders) {
      rows.push({ id: `folder:${child.path}`, kind: "folder", path: child.path, depth, isRoot: false, open });
      walk(child, depth + 1, open && (expanded[child.path] ?? true));
    }
    for (const file of node.files) {
      rows.push({ id: `file:${file}`, kind: "file", path: file, depth, isRoot: false, open });
    }
  };
  if (showRoot) {
    const rootOpen = expanded[ROOT_FOLDER_ID] ?? true;
    // Fila «Lyra» (nunca arrastrable; solo recibe «Mover a la raíz»).
    rows.push({ id: "folder:", kind: "folder", path: "", depth: 0, isRoot: true, open: true });
    for (const file of tree.files) {
      rows.push({ id: `file:${file}`, kind: "file", path: file, depth: 1, isRoot: false, open: rootOpen });
    }
    // Las carpetas de primer nivel son hermanas de la fila Lyra y siempre visibles;
    // solo los archivos directos de Lyra se colapsan con ella (comportamiento previo).
    for (const folder of topFolders) {
      const open = expanded[folder.path] ?? true;
      rows.push({ id: `folder:${folder.path}`, kind: "folder", path: folder.path, depth: 0, isRoot: false, open: true });
      walk(folder, 1, open);
    }
  } else {
    // Archivados: carpetas y archivos planos; carpetas de primer nivel según $top.
    for (const folder of topFolders) {
      const open = expanded[folder.path] ?? true;
      rows.push({ id: `folder:${folder.path}`, kind: "folder", path: folder.path, depth: 0, isRoot: false, open: true });
      walk(folder, 1, open);
    }
    for (const file of tree.files) {
      rows.push({ id: `file:${file}`, kind: "file", path: file, depth: 0, isRoot: false, open: true });
    }
  }
  return rows;
}
