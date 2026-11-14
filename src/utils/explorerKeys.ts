/**
 * Claves estables para filas del explorador.
 *
 * Las rutas físicas cambian al renombrar/mover carpetas (y sus descendientes), pero
 * React debe preservar la identidad de los componentes para evitar remontajes y
 * parpadeos. Estas claves son estables por sesión y se remapean en movimientos conocidos.
 */
const fileKeys = new Map<string, string>();
const folderKeys = new Map<string, string>();
let seq = 1;

function next(prefix: "f" | "n"): string {
  return `${prefix}${seq++}`;
}

export function getExplorerRowKey(kind: "file" | "folder", path: string): string {
  // Raíz estable con id compatible con el código DnD existente.
  if (kind === "folder" && path === "") return "folder:";
  const map = kind === "file" ? fileKeys : folderKeys;
  let key = map.get(path);
  if (!key) {
    key = next(kind === "file" ? "n" : "f");
    map.set(path, key);
  }
  return key;
}

export function remapExplorerKeys(
  changes: ReadonlyArray<{ oldPath: string; newPath: string }>,
  folderMove?: { oldPath: string; newPath: string },
): void {
  const renamePath = (p: string): string => {
    if (folderMove) {
      if (p === folderMove.oldPath) return folderMove.newPath;
      const prefix = `${folderMove.oldPath}/`;
      if (p.startsWith(prefix)) return `${folderMove.newPath}${p.slice(folderMove.oldPath.length)}`;
    }
    const direct = changes.find(c => c.oldPath === p);
    return direct ? direct.newPath : p;
  };

  const remapMap = (map: Map<string, string>) => {
    const entries = [...map.entries()];
    let changed = false;
    for (const [p] of entries) {
      const rp = renamePath(p);
      if (rp !== p) { changed = true; break; }
    }
    if (!changed) return;
    const next = new Map<string, string>();
    for (const [p, key] of entries) {
      next.set(renamePath(p), key);
    }
    map.clear();
    for (const [p, key] of next.entries()) map.set(p, key);
  };

  remapMap(fileKeys);
  remapMap(folderKeys);
}

/** Elimina claves de rutas que ya no existen (evita crecimiento y colisiones por reutilización). */
export function pruneExplorerKeys(existingFiles: readonly string[], existingFolders: readonly string[]): void {
  const fileSet = new Set(existingFiles);
  const folderSet = new Set(existingFolders);
  folderSet.add("");
  for (const p of [...fileKeys.keys()]) {
    if (!fileSet.has(p)) fileKeys.delete(p);
  }
  for (const p of [...folderKeys.keys()]) {
    if (!folderSet.has(p)) folderKeys.delete(p);
  }
}
