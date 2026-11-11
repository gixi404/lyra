import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ChevronDown, ChevronRight, Folder as FolderIcon } from "lucide-react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import useStorage from "../hooks/useStorage.ts";
import { buildFolderTree, insertEntry, readFolderExpandedState, reorderEntries, ROOT_FOLDER_ID, type FolderNode, type FolderOrder } from "../utils/folderTree.ts";
import { flattenVisible, type FlatRow } from "../utils/flattenExplorer.ts";
import FolderMenu from "./FolderMenu.tsx";
import { moveLocalPath } from "../utils/pathOperations.ts";
import { persistOrderAfterPhysicalMove } from "../utils/persistAfterPhysicalMove.ts";
import { getFileBaseName, getFileDirectory } from "../utils/noteName.ts";
import { notification } from "../utils/helpers.ts";
import { configStore } from "../store/configStore.ts";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

const EASING: [number, number, number, number] = [0.32, 0.72, 0.35, 1];
const ITEM_DURATION = 0.32;
const CLOSED_Y = -36;
// Escalonamiento con límite temporal: la lista completa termina de aparecer en
// ~180 ms aunque haya 70+ filas (18 ms/fila fijos daría >1 s al final).
const STAGGER_SPREAD = 0.18;

// ——— Drag and drop ———
// @hello-pangea/dnd gestiona la interacción: orden manual persistente
// (folderOrder para carpetas y fileOrder para archivos, sin mezclar ni
// renombrar entradas existentes), movimiento entre carpetas reutilizando
// moveLocalPath y sus garantías de recuperación, indicadores temporales y
// ordenación por teclado. Todas las filas son hermanas visibles dentro de un
// único Droppable; la sangría es puramente visual (paddingLeft), por lo que el
// movimiento entre carpetas anidadas funciona con la API estándar.
type DragKind = "file" | "folder";
type DropMode = "before" | "after" | "inside";
interface DragItem { kind: DragKind; path: string }
interface OverInfo { id: string; kind: DragKind; path: string; mode: DropMode }

function dragIdOf(kind: DragKind, path: string): string {
  return kind === "file" ? `file:${path}` : `folder:${path}`;
}

function parseDragId(id: string): DragItem | null {
  if (id.startsWith("file:")) return { kind: "file", path: id.slice("file:".length) };
  if (id.startsWith("folder:")) return { kind: "folder", path: id.slice("folder:".length) };
  return null;
}

function parentPathOf(kind: DragKind, path: string): string {
  if (kind === "folder") {
    const cut = path.lastIndexOf("/");
    return cut === -1 ? "$top" : path.slice(0, cut);
  }
  return getFileDirectory(path);
}

function DropIndicator({ active, mode }: { active: boolean; mode: "before" | "after" }) {
  if (!active) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute left-0 right-0 z-20 h-[2px] rounded-full bg-sky-400 ${mode === "before" ? "-top-px" : "-bottom-px"}`}
    />
  );
}

export default function FolderExplorer({ folders, files, renderFile, showRoot = true, archivedPaths = [], manualOrder = false }: {
  folders: string[];
  files: string[];
  renderFile: (name: string, depth: number) => ReactNode;
  showRoot?: boolean;
  archivedPaths?: string[];
  manualOrder?: boolean;
}) {
  const { setItem } = useStorage();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readFolderExpandedState(window.localStorage));
  const [order, setOrder] = useState<FolderOrder>(() => readJson("folderOrder", {}));
  const [fileOrder, setFileOrder] = useState<FolderOrder>(() => readJson("fileOrder", {}));
  const prefTick = configStore(state => state.prefTick);
  // `instant` distingue la restauración programática del estado (montaje o cambio de
  // preferencias) de la interacción manual: en restauración el árbol se pinta en su
  // estado final sin animaciones; los clics del usuario siempre animan.
  const [instant, setInstant] = useState(true);
  const [reducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const noAnim = instant || reducedMotion;
  const dndEnabled = archivedPaths.length === 0;
  const filesDraggable = dndEnabled && manualOrder;
  const [activeDrag, setActiveDrag] = useState<DragItem | null>(null);
  const [pointerY, setPointerY] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const tree = useMemo(() => buildFolderTree(folders, files, order, manualOrder ? fileOrder : undefined), [folders, files, order, manualOrder, fileOrder]);
  const flatRows = useMemo(() => flattenVisible(tree, expanded, showRoot, order), [tree, expanded, showRoot, order]);

  // Restauración programática (p. ej. cambio de preferencias) solo cuando el contenido
  // leído de localStorage difiere del estado actual. Un toggle manual escribe
  // folderExpanded y también eleva prefTick, pero el estado ya coincide, por lo que
  // la animación manual NO se desactiva.
  const expandedRef = useRef(expanded);
  const orderRef = useRef(order);
  const fileOrderRef = useRef(fileOrder);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { orderRef.current = order; }, [order]);
  useEffect(() => { fileOrderRef.current = fileOrder; }, [fileOrder]);

  useEffect(() => {
    const nextExpanded = readFolderExpandedState(window.localStorage);
    const nextOrder = readJson("folderOrder", {});
    const nextFileOrder = readJson("fileOrder", {});
    const recordEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every(key => {
        const aValue = a[key];
        const bValue = b[key];
        return Array.isArray(aValue) || Array.isArray(bValue)
          ? Array.isArray(aValue) && Array.isArray(bValue) && aValue.length === bValue.length && aValue.every((item, index) => item === bValue[index])
          : aValue === bValue;
      });
    };
    if (recordEqual(expandedRef.current, nextExpanded) && recordEqual(orderRef.current, nextOrder) && recordEqual(fileOrderRef.current, nextFileOrder)) return;
    setInstant(true);
    setExpanded(nextExpanded);
    setOrder(nextOrder);
    setFileOrder(nextFileOrder);
  }, [prefTick]);

  useLayoutEffect(() => {
    if (instant) setInstant(false);
  }, [instant, expanded, order, fileOrder]);

  // Rastrear la posición vertical del puntero mientras arrastramos para
  // indicadores de destino (antes/después/dentro) y para el drop físico.
  useEffect(() => {
    if (!activeDrag) { setPointerY(null); return; }
    const onMove = (event: PointerEvent) => setPointerY(event.clientY);
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [activeDrag]);

  function toggle(path: string) {
    const id = path || ROOT_FOLDER_ID;
    const next = { ...expanded, [id]: !(expanded[id] ?? true) };
    setExpanded(next);
    setItem("folderExpanded", JSON.stringify(next));
  }

  function findNode(root: FolderNode, path: string): FolderNode | null {
    if (root.path === path) return root;
    for (const child of root.folders) {
      const found = findNode(child, path);
      if (found) return found;
    }
    return null;
  }

  function removeFromAllLists(map: FolderOrder, entry: string): FolderOrder {
    const next: FolderOrder = {};
    for (const [parent, entries] of Object.entries(map)) {
      if (Array.isArray(entries)) next[parent] = entries.filter(path => path !== entry);
    }
    return next;
  }

  function dropTargetFor(pointerYValue: number | null, rect: { top: number; height: number }, kind: DragKind): DropMode {
    if (pointerYValue === null) return "before";
    const ratio = rect.height > 0 ? (pointerYValue - rect.top) / rect.height : 0.5;
    if (kind === "folder") {
      if (ratio < 0.3) return "before";
      if (ratio > 0.7) return "after";
      return "inside";
    }
    return ratio < 0.5 ? "before" : "after";
  }

  function computeDropMode(active: DragItem, over: DragItem, rect: { top: number; height: number }, pointerYValue: number | null, activeIndex: number, overIndex: number): DropMode | null {
    if (active.path === over.path && active.kind === over.kind) return null; // soltar sobre el origen = sin cambios
    if (active.kind === "folder" && over.path.startsWith(`${active.path}/`)) return null; // circular
    const sameLevel = parentPathOf(active.kind, active.path) === parentPathOf(over.kind, over.path);
    // Destino «Lyra» (ruta vacía): siempre «inside» (mover a la raíz).
    if (over.path === "") return "inside";
    // Mismo padre: el lado se decide por el índice — el puntero sobre elementos
    // desplazados durante el arrastre hace que la comparación Y sea inestable.
    if (sameLevel) {
      if (activeIndex === -1 || overIndex === -1) return null;
      return activeIndex < overIndex ? "after" : "before";
    }
    // Cambio de padre: indicador por posición del puntero.
    if (pointerYValue === null) return "after";
    return dropTargetFor(pointerYValue, rect, over.kind === "folder" ? "folder" : "file");
  }

  function indexOfEntry(item: DragItem): number {
    if (item.kind === "folder") {
      const parent = parentPathOf("folder", item.path);
      const siblings = parent === "$top"
        ? tree.folders.map(folder => folder.path)
        : (findNode(tree, parent)?.folders.map(folder => folder.path) ?? []);
      return siblings.indexOf(item.path);
    }
    return (findNode(tree, getFileDirectory(item.path))?.files ?? []).indexOf(item.path);
  }

  // Fila destino candidata: la fila ajena más cercana verticalmente al puntero.
  // La fila arrastrada viaja con el puntero, por lo que se excluye del cálculo,
  // y las filas dentro del propio arrastrado (su subárbol) tampoco son destinos.
  function nearestRowTo(clientYValue: number | null, dragged: DragItem | null): { row: FlatRow; rect: DOMRect } | null {
    if (clientYValue === null || !listRef.current) return null;
    const draggedId = dragged ? dragIdOf(dragged.kind, dragged.path) : null;
    let best: { row: FlatRow; rect: DOMRect; distance: number } | null = null;
    for (const row of listRef.current.querySelectorAll<HTMLElement>("[data-dnd-id]")) {
      const id = row.dataset.dndId;
      if (!id || id === draggedId) continue;
      if (row.dataset.open === "0") continue; // colapsada: sin altura medible
      const parsed = parseDragId(id);
      if (!parsed) continue;
      if (dragged?.kind === "folder" && parsed.kind === "folder" && parsed.path.startsWith(`${dragged.path}/`)) continue;
      const r = row.getBoundingClientRect();
      const distance = Math.abs((r.top + r.bottom) / 2 - clientYValue);
      if (!best || distance < best.distance) {
        best = {
          row: { id, kind: parsed.kind, path: parsed.path, depth: Number(row.dataset.depth ?? 0), isRoot: row.dataset.root === "1", open: row.dataset.open === "1" },
          rect: r,
          distance,
        };
      }
    }
    return best ? { row: best.row, rect: best.rect } : null;
  }

  const overInfo: OverInfo | null = useMemo(() => {
    if (!activeDrag || pointerY === null) return null;
    const nearest = nearestRowTo(pointerY, activeDrag);
    if (!nearest) return null;
    const { row, rect } = nearest;
    const b: DragItem = { kind: row.kind, path: row.path };
    const mode = computeDropMode(activeDrag, b, rect, pointerY, indexOfEntry(activeDrag), indexOfEntry(b));
    if (!mode) return null;
    return { id: dragIdOf(b.kind, b.path), kind: b.kind, path: b.path, mode };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrag, pointerY, flatRows]);

  function persistFiles(next: FolderOrder): void {
    setFileOrder(next);
    setItem("fileOrder", JSON.stringify(next));
  }

  function persistFolders(next: FolderOrder): void {
    setOrder(next);
    setItem("folderOrder", JSON.stringify(next));
  }

  async function moveEntry(item: DragItem, targetPath: string): Promise<boolean> {
    const base = getFileBaseName(item.path);
    const destination = targetPath ? `${targetPath}/${base}` : base;
    if (destination === item.path) return false; // no-op
    try {
      const warnings = await moveLocalPath(item.kind, item.path, destination);
      warnings.forEach(warning => notification("error", warning));
      return true;
    } catch (error) {
      notification("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  function handleDragStart(start: { draggableId: string }): void {
    setActiveDrag(parseDragId(start.draggableId));
  }

  async function handleDragEnd(result: DropResult): Promise<void> {
    setActiveDrag(null);
    // Escape o soltar fuera de la lista cancela el arrastre sin tocar el orden.
    if (result.reason !== "DROP") return;
    const a = parseDragId(result.draggableId);
    if (!a) return;
    // La ruta física y las preferencias cambian DURANTE el movimiento (moveLocalPath
    // remapea en localStorage vía migratePreferences). Leer el estado fresco en vez
    // de la copia React evita arrastrar entradas stale al reescribir localStorage/disco.
    const freshMap = (kind: DragKind): FolderOrder => readJson(kind === "folder" ? "folderOrder" : "fileOrder", {});
    const parentKeyOf = (item: DragItem): string =>
      item.kind === "file" ? getFileDirectory(item.path) : (item.path.includes("/") ? getFileDirectory(item.path) : "$top");
    const destSiblingsOf = (map: FolderOrder, item: DragItem): string[] => map[parentKeyOf(item)] ?? [];

    // Destino determinista calculado con los rects reales del DOM: la fila
    // ajena más cercana verticalmente al puntero es el destino. Con teclado no
    // hay coordenadas; se usa el último destino anunciado (overInfo) y, en
    // última instancia, el índice de destino del propio DropResult.
    const pointerAtDrop = pointerY;
    const nearest = nearestRowTo(pointerAtDrop, a);
    let b: DragItem | null = null;
    let targetRect: { top: number; height: number } | null = null;
    if (nearest) {
      b = { kind: nearest.row.kind, path: nearest.row.path };
      targetRect = nearest.rect;
    } else if (overInfo) {
      const parsed = parseDragId(overInfo.id);
      if (parsed) b = { kind: parsed.kind, path: parsed.path };
    } else if (result.destination && result.destination.index < flatRows.length) {
      const row = flatRows[result.destination.index];
      b = { kind: row.kind, path: row.path };
    }
    if (!b) return;
    const mode = (targetRect && pointerAtDrop !== null)
      ? computeDropMode(a, b, targetRect, pointerAtDrop, indexOfEntry(a), indexOfEntry(b))
      : (overInfo?.mode ?? "before");
    if (!mode) return;

    const aKey = parentKeyOf(a);
    const bKey = parentKeyOf(b);

    // Indicador «inside» sobre una carpeta (o Lyra/raíz): mover físicamente.
    if (mode === "inside") {
      if (b.kind !== "folder" && b.path !== "") return;
      if (a.kind === "folder" && (b.path === a.path || b.path.startsWith(`${a.path}/`))) {
        notification("error", "No puedes mover una carpeta dentro de sí misma ni de sus descendientes");
        return;
      }
      const destPath = b.path ? `${b.path}/${getFileBaseName(a.path)}` : getFileBaseName(a.path);
      if (destPath === a.path) return;
      if (!(await moveEntry(a, b.path))) return;
      const map = freshMap(a.kind);
      const destListKey = b.path === "" ? "$top" : b.path;
      const cleaned = removeFromAllLists(map, destPath);
      const positioned = insertEntry(cleaned, destListKey, destPath);
      if (a.kind === "folder") setOrder(positioned); else setFileOrder(positioned);
      // Movimiento físico confirmado: guardar en disco YA, sin debounce.
      await persistOrderAfterPhysicalMove(a.kind === "folder" ? "folderOrder" : "fileOrder", positioned);
      return;
    }

    // before/after: cruzar de tipo no tiene efecto visual; se ignora.
    if (a.kind !== b.kind) return;

    // Reordenamiento puro (arrayMove): mismo padre, sin movimiento físico.
    if (aKey === bKey) {
      const map = freshMap(a.kind);
      const siblings = destSiblingsOf(map, a);
      const next = reorderEntries(map, aKey, siblings, a.path, b.path);
      if (a.kind === "folder") persistFolders(next); else persistFiles(next);
      return;
    }

    // Movimiento entre carpetas: distinto padre; movimiento físico y reposicionamiento en el destino.
    if (a.kind === "folder" && (b.path === a.path || b.path.startsWith(`${a.path}/`))) {
      notification("error", "No puedes mover una carpeta dentro de sí misma ni de sus descendientes");
      return;
    }
    const destDir = bKey === "$top" ? "" : bKey;
    const destPath = destDir ? `${destDir}/${getFileBaseName(a.path)}` : getFileBaseName(a.path);
    if (destPath === a.path) return;
    // Índice exacto de inserción en la lista del destino, calculado con el árbol previo al movimiento.
    const parentNode = destDir === "" ? tree : findNode(tree, destDir);
    const destSiblings = a.kind === "folder"
      ? (parentNode?.folders.map(folder => folder.path) ?? [])
      : (parentNode?.files ?? []);
    const bLocalIndex = destSiblings.indexOf(b.path);
    const insertAt = bLocalIndex === -1 ? destSiblings.length : bLocalIndex + (mode === "after" ? 1 : 0);
    if (!(await moveEntry(a, destDir))) return;
    // Confirmado el movimiento físico, actualizar el orden manual en la lista de destino.
    const map = freshMap(a.kind);
    const cleaned = removeFromAllLists(map, destPath);
    const targetKey = a.kind === "folder" ? (destDir === "" ? "$top" : destDir) : destDir;
    const positioned = insertEntry(cleaned, targetKey, destPath, insertAt);
    if (a.kind === "folder") setOrder(positioned); else setFileOrder(positioned);
    // Movimiento físico confirmado: guardar en disco YA, sin debounce.
    await persistOrderAfterPhysicalMove(a.kind === "folder" ? "folderOrder" : "fileOrder", positioned);
  }

  // Escalonamiento por padre: índice de cada fila respecto a sus hermanos del mismo padre.
  const stagger = useMemo(() => {
    const indices = new Map<string, { index: number; total: number }>();
    const groups = new Map<string, string[]>();
    for (const row of flatRows) {
      if (row.isRoot) continue;
      const key = row.kind === "folder"
        ? `f:${parentPathOf("folder", row.path)}`
        : `n:${getFileDirectory(row.path)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row.id);
    }
    for (const ids of groups.values()) {
      const total = ids.length;
      ids.forEach((id, i) => indices.set(id, { index: i, total }));
    }
    return indices;
  }, [flatRows]);

  // Animación de emergencia: las filas se desplazan desde la línea del encabezado de su
  // carpeta (delta uniforme < altura de fila) con cascada de opacidad limitada en el tiempo.
  // La altura la mide Motion por fila (auto ↔ 0), igual que el antiguo Collapsible, sin
  // introducir envoltorios entre hermanos.
  function rowInnerTransition(row: FlatRow) {
    const info = stagger.get(row.id);
    const delay = noAnim || !info || info.total <= 1 ? 0 : (info.index / (info.total - 1)) * STAGGER_SPREAD;
    if (noAnim) return { duration: 0 };
    return {
      duration: ITEM_DURATION,
      delay,
      ease: EASING,
      opacity: { duration: 0.2, delay, ease: EASING },
      visibility: { duration: 0, delay: row.open ? 0 : 0.2 },
    };
  }
  const heightTransition = noAnim ? { duration: 0 } : { duration: 0.3, ease: EASING };

  function renderRowInner(row: FlatRow): ReactNode {
    const open = row.open;
    const transition = rowInnerTransition(row);
    if (row.kind === "folder") {
      const isRoot = row.isRoot;
      const hint = overInfo && overInfo.kind === "folder" && overInfo.path === row.path ? overInfo : null;
      const insideHint = hint?.mode === "inside";
      const depth = row.depth;
      // El estado propio (chevron/aria-expanded) es el del toggle; la visibilidad la da row.open.
      const selfOpen = expanded[row.path || ROOT_FOLDER_ID] ?? true;
      const folderContent = (
        <div className="flex items-center">
          <button type="button" onClick={() => toggle(row.path)} aria-expanded={selfOpen}
            className={`flex min-w-0 flex-1 items-center gap-2 py-3 text-left text-sm font-medium hover:text-sky-400 ${insideHint ? "ring-2 ring-sky-400 rounded-sm" : ""}`}
            style={{ paddingLeft: depth * 20 }}>
            {selfOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <FolderIcon size={17} />
            <span className="truncate">{isRoot ? "Lyra (carpeta)" : getFileBaseName(row.path)}</span>
          </button>
          <FolderMenu path={row.path} archived={archivedPaths.includes(row.path)} structural={!showRoot && !archivedPaths.includes(row.path)} />
        </div>
      );
      return (
        <div className="relative">
          {hint && hint.mode !== "inside" ? <DropIndicator active mode={hint.mode} /> : null}
          <motion.div
            initial={false}
            animate={{ height: open ? "auto" : 0 }}
            transition={heightTransition}
            style={{ overflow: "hidden" }}
            className="motion-reduce:transition-none"
          >
            <motion.div
              initial={false}
              aria-hidden={!open}
              animate={open ? { y: 0, opacity: 1, visibility: "visible" } : { y: CLOSED_Y, opacity: 0, visibility: "hidden" }}
              transition={transition}
              style={{ pointerEvents: open ? "auto" : "none" }}
              className="motion-reduce:transition-none"
            >
              {folderContent}
            </motion.div>
          </motion.div>
        </div>
      );
    }
    const fileName = row.path;
    const childHint = overInfo && overInfo.path === fileName && overInfo.kind === "file" && overInfo.mode !== "inside" ? overInfo : null;
    return (
      <div className="relative">
        {childHint ? <DropIndicator active mode={childHint.mode as "before" | "after"} /> : null}
        <motion.div
          initial={false}
          animate={{ height: open ? "auto" : 0 }}
          transition={heightTransition}
          style={{ overflow: "hidden" }}
          className="motion-reduce:transition-none"
        >
          <motion.div
            initial={false}
            aria-hidden={!open}
            animate={open ? { y: 0, opacity: 1, visibility: "visible" } : { y: CLOSED_Y, opacity: 0, visibility: "hidden" }}
            transition={transition}
            style={{ pointerEvents: open ? "auto" : "none" }}
            className="motion-reduce:transition-none"
          >
            {renderFile(fileName, row.depth)}
          </motion.div>
        </motion.div>
      </div>
    );
  }

  function renderPlainRow(row: FlatRow): ReactNode {
    return (
      <div key={row.id} role="listitem" data-dnd-id={row.id} data-depth={row.depth} data-root={row.isRoot ? "1" : "0"} data-open={row.open ? "1" : "0"}>
        {renderRowInner(row)}
      </div>
    );
  }

  function renderDraggableRow(row: FlatRow, index: number): ReactNode {
    const disabled = row.isRoot || (row.kind === "file" && !filesDraggable);
    return (
      <Draggable key={row.id} draggableId={row.id} index={index} isDragDisabled={disabled}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            {...provided.dragHandleProps}
            role="listitem"
            data-dnd-id={row.id}
            data-depth={row.depth}
            data-root={row.isRoot ? "1" : "0"}
            data-open={row.open ? "1" : "0"}
            aria-roledescription="elemento ordenable"
            className="relative"
            style={snapshot.isDragging ? { zIndex: 30, boxShadow: "0 12px 32px rgba(0,0,0,0.45)" } : undefined}
          >
            {renderRowInner(row)}
          </div>
        )}
      </Draggable>
    );
  }

  const rows = flatRows;

  if (!dndEnabled) {
    return (
      <ul ref={listRef} className="flex flex-col w-[680px] max-w-full pb-20 animate-list-switch" role="list">
        {rows.map(renderPlainRow)}
      </ul>
    );
  }

  return (
    <DragDropContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <Droppable droppableId="explorer">
        {(provided) => (
          <ul
            ref={element => { provided.innerRef(element); listRef.current = element ?? null; }}
            {...provided.droppableProps}
            className="flex flex-col w-[680px] max-w-full pb-20 animate-list-switch"
            role="list"
          >
            {rows.map((row, i) => renderDraggableRow(row, i))}
            {provided.placeholder}
          </ul>
        )}
      </Droppable>
    </DragDropContext>
  );
}
