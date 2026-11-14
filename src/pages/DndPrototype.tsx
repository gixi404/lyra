import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder as FolderIcon } from "lucide-react";
import { motion } from "motion/react";
import { useExplorerDnd } from "../dnd-explorer/useExplorerDnd.ts";
import DragOverlay from "../dnd-explorer/DragOverlay.tsx";
import type { DropTarget, DragItem } from "../dnd-explorer/types.ts";

type Node = { id: string; name: string; folders: Node[]; files: string[] };

function buildMock(): Node {
  return {
    id: "", name: "Lyra", folders: [
      { id: "Proyectos", name: "Proyectos", folders: [
        { id: "Proyectos/Alpha", name: "Alpha", folders: [
          { id: "Proyectos/Alpha/Deep", name: "Deep", folders: [], files: ["Proyectos/Alpha/Deep/d1.md", "Proyectos/Alpha/Deep/d2.md"] }
        ], files: ["Proyectos/Alpha/a1.md", "Proyectos/Alpha/a2.md"] },
        { id: "Proyectos/Beta", name: "Beta", folders: [], files: ["Proyectos/Beta/b1.md"] },
      ], files: ["Proyectos/p1.md", "Proyectos/p2.md"] },
      { id: "Ideas", name: "Ideas", folders: [], files: ["Ideas/i1.md", "Ideas/i2.md", "Ideas/i3.md"] },
      { id: "Vacía", name: "Vacía", folders: [], files: [] },
    ], files: ["root1.md", "root2.md", "root3.md"]
  };
}

interface Flat {
  id: string; kind: "folder" | "file"; path: string; depth: number; open: boolean; isRoot: boolean; containerKey: string;
}

function flattenProper(node: Node, expanded: Record<string, boolean>): Flat[] {
  const rows: Flat[] = [];
  const walk = (n: Node, depth: number, ancestorOpen: boolean) => {
    for (const child of n.folders) {
      const selfExpanded = expanded[child.id] ?? true;
      rows.push({ id: `folder:${child.id}`, kind: "folder", path: child.id, depth, open: ancestorOpen, isRoot: false, containerKey: n.id });
      walk(child, depth + 1, ancestorOpen && selfExpanded);
    }
    for (const f of n.files) {
      rows.push({ id: `file:${f}`, kind: "file", path: f, depth, open: ancestorOpen, isRoot: false, containerKey: n.id });
    }
  };
  const rootOpen = expanded["root:lyra"] ?? true;
  rows.push({ id: "folder:", kind: "folder", path: "", depth: 0, open: true, isRoot: true, containerKey: "" });
  for (const f of node.files) rows.push({ id: `file:${f}`, kind: "file", path: f, depth: 1, open: rootOpen, isRoot: false, containerKey: "" });
  for (const child of node.folders) {
    const selfExpanded = expanded[child.id] ?? true;
    rows.push({ id: `folder:${child.id}`, kind: "folder", path: child.id, depth: 0, open: true, isRoot: false, containerKey: "" });
    walk(child, 1, selfExpanded);
  }
  return rows;
}

export default function DndPrototype() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "root:lyra": true, "Proyectos": true, "Proyectos/Alpha": false, "Proyectos/Beta": true, "Ideas": true, "Vacía": true, "Proyectos/Alpha/Deep": true });
  const [tempExpanded, setTempExpanded] = useState<Record<string, boolean>>({});
  const [log, setLog] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const effective = useMemo(() => ({ ...expanded, ...tempExpanded }), [expanded, tempExpanded]);
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  const rows = useMemo(() => flattenProper(buildMock(), effective), [effective]);

  const { dnd, onPointerDownRow, onClickCapture } = useExplorerDnd({
    rootRef,
    scrollRef,
    enabled: true,
    manualOrder: true,
    canDragFolders: true,
    isEffectivelyExpanded: (path, isRoot) => {
      const e = effectiveRef.current;
      return isRoot ? (e["root:lyra"] ?? true) : !!e[path];
    },
    requestTempExpand: (path, isRoot) => {
      setTempExpanded(prev => ({ ...prev, [isRoot ? "root:lyra" : path]: true }));
    },
    onDrop: async (item: DragItem, target: DropTarget, reason) => {
      setLog(l => [`${reason}: ${item.id} -> ${JSON.stringify(target)}`, ...l].slice(0, 12));
      // simulate success: keep target container/folder ancestors expanded
      if (reason === "cancel" || !target) { setTempExpanded({}); return null; }
      setTempExpanded({});
      return [];
    },
    onDragEnd: (_keep, cancelled) => {
      if (cancelled) setTempExpanded({});
      else setTempExpanded({});
    },
  });

  // build segments
  const segments = useMemo(() => {
    const base: Array<{ kind: "folder"; row: Flat } | { kind: "files"; containerKey: string; rows: Flat[] }> = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.kind === "folder") { base.push({ kind: "folder", row: r }); i++; }
      else {
        const ck = r.containerKey; const rs: Flat[] = [];
        while (i < rows.length && rows[i].kind === "file" && rows[i].containerKey === ck) { rs.push(rows[i]); i++; }
        base.push({ kind: "files", containerKey: ck, rows: rs });
      }
    }
    const fileSegKeys = new Set(base.filter(s => s.kind === "files").map(s => s.containerKey));
    const segs: typeof base = [];
    for (const seg of base) {
      segs.push(seg);
      if (seg.kind === "folder") {
        const selfKey = seg.row.isRoot ? "root:lyra" : seg.row.path;
        const selfOpen = (effective[selfKey] ?? true) && seg.row.open;
        const containerKey = seg.row.path;
        if (selfOpen && !fileSegKeys.has(containerKey)) {
          segs.push({ kind: "files", containerKey, rows: [] });
          fileSegKeys.add(containerKey);
        }
      }
    }
    return segs;
  }, [rows, effective]);

  const dragged = dnd.dragging;

  return (
    <div style={{ padding: 20, color: "#eee", background: "#101010", minHeight: "100vh" }}>
      <h2 style={{ marginBottom: 8 }}>DND Prototype</h2>
      <div ref={scrollRef} data-explorer-scroll style={{ height: 420, overflow: "auto", border: "1px solid #333", borderRadius: 8, padding: 8, width: 680, maxWidth: "100%" }}>
        <div ref={rootRef} onClickCapture={onClickCapture} style={{ position: "relative" }}>
          {segments.map(seg => {
            if (seg.kind === "folder") {
              const r = seg.row;
              const selfKey = r.isRoot ? "root:lyra" : r.path;
              const selfOpen = effective[selfKey] ?? true;
              const isHover = dnd.folderHoverPath === r.path;
              return (
                <motion.div key={r.id} initial={false} animate={{ height: r.open ? "auto" : 0 }} style={{ overflow: "hidden" }}>
                  <div data-explorer-row-id={r.id} data-explorer-row-kind="folder" data-folder-path={r.path} data-folder-open={selfOpen ? "1" : "0"}
                    onPointerDown={(e) => onPointerDownRow(e, r.id)}
                    style={{ padding: "10px 8px", paddingLeft: r.depth * 20 + 8, display: "flex", alignItems: "center", gap: 8, cursor: r.isRoot ? "default" : "grab", background: isHover ? "rgba(56,189,248,0.12)" : undefined, borderRadius: 6, opacity: dragged?.id === r.id ? 0.3 : 1 }}>
                    <span onClick={(e) => { e.stopPropagation(); setExpanded(p => ({ ...p, [selfKey]: !(p[selfKey] ?? true) })); }} style={{ display: "inline-flex", cursor: "pointer" }}>
                      {selfOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                    <FolderIcon size={16} /> <span>{r.isRoot ? "Lyra (carpeta)" : r.path.split("/").pop()}</span>
                  </div>
                </motion.div>
              );
            }
            const { containerKey, rows: frows } = seg;
            const blockOpen = frows.length === 0 ? true : frows[0].open;
            const insertTarget = (dnd.dropTarget && dnd.dropTarget.type === "file-insert" && dnd.dropTarget.containerKey === containerKey) ? dnd.dropTarget.index : null;
            const gapHeight = dnd.cloneSize?.height ?? 44;
            const hasDraggedInBlock = !!dragged && frows.some(r => r.id === dragged.id);
            // Preserve source space to prevent layout shifts, but avoid doubling space when insertion gap is in this same container.
            const insertInThisContainer = insertTarget !== null && dragged?.kind === "file";
            const showSourcePlaceholder = hasDraggedInBlock && dragged?.kind === "file" && !insertInThisContainer;
            let visIdx = 0;
            const items: ReactNode[] = [];
            for (const r of frows) {
              const isDragged = dragged?.id === r.id;
              if (isDragged) {
                if (showSourcePlaceholder) {
                  items.push(<div key={`${r.id}:src`} aria-hidden="true" style={{ height: gapHeight, borderRadius: 6 }} />);
                }
                continue;
              }
              if (insertTarget !== null && visIdx === insertTarget && dragged?.kind === "file") {
                items.push(<motion.div key={`${containerKey}:gap:${visIdx}`} layout initial={{ height: 0, opacity: 0 }} animate={{ height: gapHeight, opacity: 0.2 }} style={{ background: "rgba(56,189,248,0.2)", borderRadius: 6, margin: "2px 0" }} />);
              }
              items.push(
                <div key={r.id} data-explorer-row-id={r.id} data-explorer-row-kind="file"
                  onPointerDown={(e) => onPointerDownRow(e, r.id)}
                  style={{ padding: "10px 8px", paddingLeft: r.depth * 20 + 28, display: "flex", alignItems: "center", gap: 8, cursor: "grab", borderRadius: 6 }}>
                  <FileText size={15} /> <span>{r.path.split("/").pop()}</span>
                </div>
              );
              visIdx++;
            }
            if (insertTarget !== null && insertTarget >= visIdx && dragged?.kind === "file") {
              items.push(<motion.div key={`${containerKey}:gap:end`} layout initial={{ height: 0, opacity: 0 }} animate={{ height: gapHeight, opacity: 0.2 }} style={{ background: "rgba(56,189,248,0.2)", borderRadius: 6, margin: "2px 0" }} />);
            }
            return (
              <motion.div key={`files:${containerKey}`} initial={false} animate={{ height: blockOpen ? "auto" : 0 }} style={{ overflow: "hidden" }}>
                <div data-file-droppable={containerKey} style={{ display: "flex", flexDirection: "column", minHeight: frows.length === 0 ? 28 : undefined }}>
                  {items}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
      <DragOverlay dnd={dnd}>
        {dragged ? (
          <div style={{ padding: "10px 12px", background: "#1f2937", color: "#fff", borderRadius: 8, display: "flex", alignItems: "center", gap: 8, height: "100%" }}>
            {dragged.kind === "folder" ? <FolderIcon size={16} /> : <FileText size={15} />}
            <span>{dragged.path === "" ? "Lyra (carpeta)" : dragged.path.split("/").pop()}</span>
          </div>
        ) : null}
      </DragOverlay>
      <pre style={{ marginTop: 12, fontSize: 12, color: "#9ca3af", maxHeight: 200, overflow: "auto" }}>{log.join("\n")}</pre>
      <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af" }}>target: {JSON.stringify(dnd.dropTarget)} hover: {String(dnd.folderHoverPath)}</div>
    </div>
  );
}
