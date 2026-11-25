import { useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { DragDropProvider, DragOverlay, useDroppable } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";

type FolderId = "root" | "projects" | "alpha" | "deep" | "ideas" | "empty";
type FileId = string;
type Contents = Record<FolderId, FileId[]>;
const initial: Contents = {
  root: ["Welcome.txt", "Notes.txt"],
  projects: ["Plan.md", "Timeline.md"],
  alpha: ["Design.md", "Research.md"],
  deep: ["Archive.md"],
  ideas: ["Idea 1.md", "Idea 2.md", "Idea 3.md"],
  empty: [],
};
const children: Partial<Record<FolderId, FolderId[]>> = {
  root: ["projects", "ideas", "empty"],
  projects: ["alpha"],
  alpha: ["deep"],
};
const labels: Record<FolderId, string> = {
  root: "Lyra", projects: "Projects", alpha: "Alpha", deep: "Deep", ideas: "Ideas", empty: "Empty folder",
};
const fileId = (name: string) => `file:${name}`;
const folderId = (name: FolderId) => `folder:${name}`;

function FileRow({ name, group, index, depth }: { name: string; group: FolderId; index: number; depth: number }) {
  const { ref, isDragging } = useSortable({
    id: fileId(name), index, group, type: "file", accept: "file",
    transition: { duration: 190, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  });
  return (
    <div ref={ref} data-testid={fileId(name)} data-group={group}
      style={{ padding: "11px 12px", paddingLeft: 18 + depth * 20, borderBottom: "1px solid #363b45", background: "#242b36", borderRadius: 5, cursor: "grab", opacity: isDragging ? 0.35 : 1, touchAction: "none", userSelect: "none" }}>
      <FileText size={15} style={{ display: "inline", verticalAlign: "middle", marginRight: 8 }} />{name}
    </div>
  );
}

function FolderRow({ id, depth, expanded, onToggle, active }: { id: FolderId; depth: number; expanded: boolean; onToggle: () => void; active: boolean }) {
  const { ref, isDropTarget } = useDroppable({ id: folderId(id), type: "folder", accept: "file", collisionPriority: 1 });
  return (
    <div ref={ref} data-testid={folderId(id)} onClick={onToggle}
      style={{ padding: "12px", paddingLeft: 12 + depth * 20, background: isDropTarget || active ? "#30577a" : "#17202c", borderRadius: 5, cursor: "pointer", marginTop: 3 }}>
      <ChevronRight size={16} style={{ display: "inline", verticalAlign: "middle", transform: expanded ? "rotate(90deg)" : undefined, transition: "transform 190ms" }} />
      <Folder size={16} style={{ display: "inline", verticalAlign: "middle", margin: "0 8px" }} />{labels[id]}
    </div>
  );
}

export default function DndPrototype() {
  const [contents, setContents] = useState<Contents>(initial);
  const [expanded, setExpanded] = useState<Record<FolderId, boolean>>({ root: true, projects: true, alpha: false, deep: false, ideas: true, empty: true });
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<FolderId | null>(null);
  const [log, setLog] = useState("Hold a file for 150 ms or move it 8 px to drag it.");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => () => clearTimer(), []);

  function renderFolder(id: FolderId, depth: number): React.ReactNode {
    return (
      <div key={id}>
        <FolderRow id={id} depth={depth} expanded={expanded[id]} active={hover === id}
          onToggle={() => setExpanded(current => ({ ...current, [id]: !current[id] }))} />
        <div style={{ overflow: "hidden", maxHeight: expanded[id] ? 4000 : 0, opacity: expanded[id] ? 1 : 0, transition: "max-height 220ms ease, opacity 220ms ease" }}>
          {(children[id] ?? []).map(child => renderFolder(child, depth + 1))}
          <div data-testid={`list:${id}`} style={{ minHeight: 30, padding: "3px 0" }}>
            {contents[id].map((name, index) => <FileRow key={fileId(name)} name={name} group={id} index={index} depth={depth + 1} />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <DragDropProvider
      sensors={defaults => [...defaults.filter(sensor => sensor !== PointerSensor), PointerSensor.configure({
        activationConstraints: [
          new PointerActivationConstraints.Distance({ value: 8 }),
          new PointerActivationConstraints.Delay({ value: 150, tolerance: 12 }),
        ],
      })]}
      onDragStart={event => { setActive(String(event.operation.source?.id ?? "")); setLog("Dragging"); }}
      onDragOver={event => {
        const target = event.operation.target;
        const folder = typeof target?.id === "string" && target.id.startsWith("folder:") ? target.id.slice(7) as FolderId : null;
        if (folder === hover) return;
        clearTimer(); setHover(folder);
        if (folder && !expanded[folder]) timer.current = setTimeout(() => setExpanded(current => ({ ...current, [folder]: true })), 500);
      }}
      onDragEnd={event => {
        clearTimer(); setHover(null); setActive(null);
        if (event.canceled) { setLog("Canceled"); return; }
        const { source, target } = event.operation;
        if (!isSortable(source)) { setLog("Invalid source"); return; }
        const from = source.initialGroup as FolderId;
        const to = typeof target?.id === "string" && target.id.startsWith("folder:")
          ? target.id.slice(7) as FolderId : source.group as FolderId;
        const name = String(source.id).slice(5);
        if (!(from in contents) || !(to in contents)) { setLog("Invalid target"); return; }
        setContents(current => {
          const next = { ...current, [from]: current[from].filter(item => item !== name) };
          const destination = from === to ? next[to] : [...current[to]];
          destination.splice(Math.max(0, Math.min(source.index, destination.length)), 0, name);
          next[to] = destination;
          return next;
        });
        setLog(`${name}: ${labels[from]} → ${labels[to]} (${source.index})`);
      }}
    >
      <main style={{ background: "#101722", color: "#f3f4f6", minHeight: "100vh", padding: 24, fontFamily: "sans-serif" }}>
        <h1>Drag and drop prototype</h1>
        <p>Fictional files only. Escape cancels the operation.</p>
        <div data-testid="prototype-scroll" style={{ width: 650, maxWidth: "100%", height: 380, overflowY: "auto", border: "1px solid #475569", padding: 8 }}>
          {renderFolder("root", 0)}
        </div>
        <p data-testid="prototype-status">{log}</p>
      </main>
      <DragOverlay dropAnimation={{ duration: 190, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
        {active ? <div style={{ padding: 12, width: 320, background: "#334155", color: "white", borderRadius: 6, boxShadow: "0 10px 30px #0008" }}>{active.slice(5)}</div> : null}
      </DragOverlay>
    </DragDropProvider>
  );
}
