import type { ContainerGeometry, FolderRowGeometry } from "./types.ts";

export function measureFileContainers(root: HTMLElement, draggedId: string | null): Map<string, ContainerGeometry> {
  const map = new Map<string, ContainerGeometry>();
  const containers = root.querySelectorAll<HTMLElement>("[data-file-droppable]");
  containers.forEach(el => {
    const containerKey = el.dataset.fileDroppable ?? "";
    const rect = el.getBoundingClientRect();
    const itemEls = Array.from(el.querySelectorAll<HTMLElement>("[data-explorer-row-id][data-explorer-row-kind='file']"));
    const itemRects = itemEls
      .filter(item => item.dataset.explorerRowId !== draggedId)
      .map(item => {
        const r = item.getBoundingClientRect();
        const id = item.dataset.explorerRowId ?? "";
        const path = item.dataset.explorerPath ?? (id.startsWith("file:") ? id.slice("file:".length) : "");
        return { id, path, rect: r, midY: r.top + r.height / 2 };
      })
      .filter(i => i.id);
    map.set(containerKey, { containerKey, rect, itemRects });
  });
  return map;
}

export function measureFolderRows(root: HTMLElement): FolderRowGeometry[] {
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-explorer-row-id][data-explorer-row-kind='folder']"));
  return rows.map(el => {
    const id = el.dataset.explorerRowId ?? "";
    const path = el.dataset.folderPath ?? el.dataset.explorerPath ?? (id === "folder:" ? "" : (id.startsWith("folder:") ? id.slice("folder:".length) : ""));
    const rect = el.getBoundingClientRect();
    const parent = path === "" ? "" : path.split("/").slice(0, -1).join("/");
    return {
      id,
      path,
      isRoot: id === "folder:" || path === "",
      rect,
      midY: rect.top + rect.height / 2,
      parentKey: path === "" ? "" : parent, // root row not used for reorder; for others parent dir ("" means top-level)
    };
  });
}

export function computeInsertIndex(
  container: ContainerGeometry,
  clientY: number,
  prevIndex?: number | null,
): number {
  const { itemRects } = container;
  // Use measured midYs directly: DOM/layout already reflects the current rendered gap.
  const mids = itemRects.map(it => it.midY);
  const hysteresis = 10;

  let idx = mids.length;
  for (let i = 0; i < mids.length; i++) {
    if (clientY < mids[i]) { idx = i; break; }
  }

  // Hysteresis around the previous index boundaries to prevent oscillation when the gap
  // shifts layout and the pointer sits near a boundary.
  if (typeof prevIndex === "number" && prevIndex >= 0) {
    // moving up: would cross boundary above prevIndex (between prevIndex-1 and prevIndex)
    if (idx < prevIndex && prevIndex - 1 < mids.length) {
      const boundary = mids[prevIndex - 1];
      if (clientY > boundary - hysteresis) idx = prevIndex;
    }
    // moving down: would cross boundary below prevIndex (between prevIndex and prevIndex+1)
    if (idx > prevIndex && prevIndex < mids.length) {
      const boundary = mids[prevIndex];
      if (clientY < boundary + hysteresis) idx = prevIndex;
    }
  }

  return idx;
}

export function detectFolderHover(
  clientX: number,
  clientY: number,
  folderRows: FolderRowGeometry[],
  dragged: { kind: "file" | "folder"; path: string; isRoot: boolean } | null,
): string | null {
  // Prefer the most specific (deepest / smallest-height visually fine) row under point; if multiple overlap, last in DOM order among those containing point tends to be inner - but rows are separate.
  let hit: FolderRowGeometry | null = null;
  for (const row of folderRows) {
    const r = row.rect;
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
    if (dragged && row.path === dragged.path && !(dragged.isRoot && row.path === "")) continue;
    if (dragged?.kind === "folder" && dragged.isRoot) continue;
    if (dragged?.kind === "folder" && dragged.path !== "" && row.path !== "" && (row.path === dragged.path || row.path.startsWith(`${dragged.path}/`))) continue;
    hit = row; // rows in DOM order; deeper rows appear later - keep last match
  }
  if (!hit) return null;
  return hit.path; // "" for Lyra
}

export function detectFileContainer(clientX: number, clientY: number, containers: Map<string, ContainerGeometry>): ContainerGeometry | null {
  // choose container whose rect contains point (vertically) with horizontal tolerance; if nested, prefer smaller rect
  let best: ContainerGeometry | null = null;
  for (const c of containers.values()) {
    const r = c.rect;
    if (clientY < r.top || clientY > r.bottom) continue;
    if (clientX < r.left - 40 || clientX > r.right + 40) continue;
    if (!best || r.height <= best.rect.height) best = c;
  }
  return best;
}
