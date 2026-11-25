import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { DragDropProvider, DragOverlay as DndDragOverlay, useDroppable } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { AutoScroller, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import useStorage from "../hooks/useStorage.ts";
import { buildFolderTree, readFolderExpandedState, ROOT_FOLDER_ID, type FolderOrder } from "../utils/folderTree.ts";
import { flattenVisible, type FlatRow } from "../utils/flattenExplorer.ts";
import { getExplorerRowKey } from "../utils/explorerKeys.ts";
import FolderMenu from "./FolderMenu.tsx";
import { classifyArchivedViewFolder } from "../utils/archivePathState.ts";
import { moveLocalPath } from "../utils/pathOperations.ts";
import { persistOrderAfterPhysicalMove } from "../utils/persistAfterPhysicalMove.ts";
import { getFileBaseName, getFileDirectory } from "../utils/noteName.ts";
import { notification } from "../utils/helpers.ts";
import { configStore } from "../store/configStore.ts";
import { searchStore } from "../store/searchStore.ts";
import { ancestorsOf } from "../utils/dndExpansion.ts";
import { EXPLORER_DND_ENABLED } from "../dnd-explorer/config.ts";
import { getFolderIconColors, getFolderIcons, getFolderTextColors, resolveFolderColor, resolveFolderIcon } from "../utils/folderAppearance.ts";
import { displayFolderName } from "../utils/visibleNames.ts";
import { themes } from "../utils/helpers.ts";
import { getForcedExpandedForSearch } from "../utils/searchProjection.ts";
import type { DragItem, DropTarget } from "../dnd-explorer/types.ts";
import { bindMetadataWithFeedback, metadataOrderValid, prepareMetadataWrite } from "../utils/metadataIdentity.ts";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

const EASING: [number, number, number, number] = [0.32, 0.72, 0.35, 1];
const ITEM_DURATION = 0.32;
const FOLD_DURATION = 0.3;
const CLOSED_Y = -36;
const STAGGER_SPREAD = 0.18;

function fileContainerKeyForPath(path: string): string {
  return getFileDirectory(path);
}

function readVisibleFilePlacement(list: HTMLElement, rowId: string, containerKey: string): string[] | undefined {
  const rows = Array.from(list.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.dataset.open === "1");
  const isDestinationFile = (row: HTMLElement | undefined) =>
    row?.dataset.explorerRowKind === "file" && row.dataset.explorerPath !== undefined
      && fileContainerKeyForPath(row.dataset.explorerPath) === containerKey;
  const index = rows.findIndex(row => row.dataset.explorerRowId === rowId);
  // dnd-kit places the source beside a destination file in the flat list.
  if (index === -1 || (!isDestinationFile(rows[index - 1]) && !isDestinationFile(rows[index + 1]))) return;
  return rows.filter((row, position) => position === index || isDestinationFile(row))
    .map(row => row.dataset.explorerPath!);
}

/** Inserta `destinationPath` en el índice visible del drop, sin duplicados. */
function insertFileAtVisibleIndex(base: string[], insertAt: number, destinationPath: string, exclude: readonly string[]): string[] {
  const list = base.filter(path => path !== destinationPath && !exclude.includes(path));
  const index = Math.max(0, Math.min(insertAt, list.length));
  list.splice(index, 0, destinationPath);
  return list;
}

const folderDropId = (id: string) => `drop-folder:${id}`;

interface OptimisticMove {
  kind: "file" | "folder";
  rowId: string;
  oldPath: string;
  newPath: string;
}

interface PendingOptimisticMove extends OptimisticMove {
  /** Clave de orden y padre destino que debe estar activo antes de retirar la proyección. */
  orderKey: "fileOrder" | "folderOrder";
  parentKey: string;
  /** Se rellena solo después de persistir el movimiento físico. */
  definitiveOrder: FolderOrder | null;
}

function sameOrderPaths(left: readonly string[] | undefined, right: readonly string[] | undefined, kind: "file" | "folder"): boolean {
  const a = (left ?? []).filter(path => metadataOrderValid(kind, path));
  const b = (right ?? []).filter(path => metadataOrderValid(kind, path));
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

function SortableFileRow({ row, group, index, children, enabled, reducedMotion }: {
  row: FlatRow; group: string; index: number; children: ReactNode; enabled: boolean; reducedMotion: boolean;
}) {
  const { ref, isDragging } = useSortable({
    id: row.id,
    index,
    group,
    type: "file",
    accept: "file",
    disabled: !enabled,
    transition: reducedMotion ? null : { duration: 190, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  });
  return (
    <div ref={ref} data-explorer-row-id={row.id} data-explorer-row-kind="file" data-explorer-path={row.path}
      data-open={row.open ? "1" : "0"} role="listitem"
      className={`relative outline-none focus:outline-none focus-visible:outline-none ${enabled ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{ opacity: isDragging ? 0.28 : 1, touchAction: enabled ? "none" : undefined }}>
      {children}
    </div>
  );
}

function DroppableFolderRow({ row, children }: { row: FlatRow; children: ReactNode }) {
  const { ref, isDropTarget } = useDroppable({
    id: folderDropId(row.id), type: "folder", accept: "file", collisionPriority: 1,
    disabled: !row.open,
  });
  return (
    <div ref={ref} data-explorer-row-id={row.id} data-explorer-row-kind="folder"
      data-explorer-path={row.path} data-folder-path={row.path} data-open={row.open ? "1" : "0"}
      role="listitem" className={`relative outline-none ${isDropTarget ? "rounded-md bg-sky-500/10" : ""}`}>
      {children}
    </div>
  );
}

export default function FolderExplorer({ folders, files, renderFile, showRoot = true, archivedPaths = [], manualOrder = false, searchActive = false }: {
  folders: string[];
  files: string[];
  renderFile: (name: string, depth: number) => ReactNode;
  showRoot?: boolean;
  archivedPaths?: string[];
  manualOrder?: boolean;
  searchActive?: boolean;
}) {
  const { setItem } = useStorage();
  const { isDay } = themes();
  const [tempExpanded, setTempExpanded] = useState<Record<string, boolean>>({});
  const [optimisticMove, setOptimisticMove] = useState<OptimisticMove | null>(null);
  // La proyección permanece pendiente hasta que el estado definitivo (props + orden)
  // reproduce exactamente el mismo árbol. `definitiveOrder` es el mapa que se ha
  // escrito en localStorage y que debe estar activo antes de retirar la proyección.
  const pendingOptimisticMoveRef = useRef<PendingOptimisticMove | null>(null);
  const prefTick = configStore(state => state.prefTick);
  const searchSnapshotRef = useRef<Record<string, boolean> | null>(null);
  const wasSearchingRef = useRef(false);
  // Captura el estado de expansión una sola vez al iniciar cada sesión de búsqueda y lo descarta al salir.
  if (searchActive && !wasSearchingRef.current) {
    searchSnapshotRef.current = readFolderExpandedState(window.localStorage);
  }
  if (!searchActive && wasSearchingRef.current) {
    searchSnapshotRef.current = null;
  }
  wasSearchingRef.current = searchActive;
  // Derivar preferencias del almacenamiento para mantener coherencia inmediata con renombres/movimientos
  // (evita estados intermedios entre props remapeadas y estado local desfasado).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read from localStorage on preference changes
  const expanded = useMemo(() => readFolderExpandedState(window.localStorage), [prefTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read from localStorage on preference changes
  const storedOrder = useMemo(() => readJson<FolderOrder>("folderOrder", {}), [prefTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read from localStorage on preference changes
  const storedFileOrder = useMemo(() => readJson<FolderOrder>("fileOrder", {}), [prefTick]);
  const [orderOverride, setOrderOverride] = useState<FolderOrder | null>(null);
  const [fileOrderOverride, setFileOrderOverride] = useState<FolderOrder | null>(null);
  const order = Object.fromEntries(Object.entries(orderOverride ?? storedOrder).map(([parent, paths]) =>
    [parent, paths.filter(path => metadataOrderValid("folder", path))]));
  const fileOrder = Object.fromEntries(Object.entries(fileOrderOverride ?? storedFileOrder).map(([parent, paths]) =>
    [parent, paths.filter(path => metadataOrderValid("file", path))]));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read localStorage appearance maps on preference changes
  const folderTextColors = useMemo(() => getFolderTextColors(), [prefTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read localStorage appearance maps on preference changes
  const folderIconColors = useMemo(() => getFolderIconColors(), [prefTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read localStorage appearance maps on preference changes
  const folderIcons = useMemo(() => getFolderIcons(), [prefTick]);
  const [reducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const noAnim = reducedMotion;
  const dndEnabled = EXPLORER_DND_ENABLED && showRoot && archivedPaths.length === 0 && !searchActive;

  const listRef = useRef<HTMLDivElement | null>(null);

  const projectedFiles = useMemo(() => {
    if (!optimisticMove) return files;
    if (optimisticMove.kind === "file") {
      if (!files.includes(optimisticMove.oldPath)) return files;
      return files.map(f => (f === optimisticMove.oldPath ? optimisticMove.newPath : f));
    }
    const { oldPath, newPath } = optimisticMove;
    const prefix = `${oldPath}/`;
    return files.map(f => (f === oldPath ? newPath : f.startsWith(prefix) ? `${newPath}/${f.slice(prefix.length)}` : f));
  }, [files, optimisticMove]);

  const forcedExpanded = useMemo(
    () => (searchActive ? getForcedExpandedForSearch(projectedFiles, showRoot) : {}),
    [searchActive, projectedFiles, showRoot],
  );

  const effectiveExpanded = useMemo(() => {
    if (searchActive) {
      return { ...(searchSnapshotRef.current ?? expanded), ...forcedExpanded };
    }
    return { ...expanded, ...tempExpanded };
  }, [searchActive, expanded, tempExpanded, forcedExpanded]);
  const projectedFolders = useMemo(() => {
    if (!optimisticMove || optimisticMove.kind !== "folder") return folders;
    const { oldPath, newPath } = optimisticMove;
    const prefix = `${oldPath}/`;
    return folders.map(f => (f === oldPath ? newPath : f.startsWith(prefix) ? `${newPath}/${f.slice(prefix.length)}` : f));
  }, [folders, optimisticMove]);
  const projectedOrder = useMemo(() => {
    if (!optimisticMove || optimisticMove.kind !== "folder") return order;
    const { oldPath, newPath } = optimisticMove;
    const prefix = `${oldPath}/`;
    const rename = (p: string) => (p === oldPath ? newPath : p.startsWith(prefix) ? `${newPath}/${p.slice(prefix.length)}` : p);
    const next: FolderOrder = {};
    for (const [k, list] of Object.entries(order)) {
      if (!Array.isArray(list)) continue;
      next[rename(k)] = list.map(rename);
    }
    return next;
  }, [order, optimisticMove]);

  const tree = useMemo(() => buildFolderTree(projectedFolders, projectedFiles, projectedOrder,
    manualOrder || optimisticMove?.kind === "file" ? fileOrder : undefined),
  [projectedFolders, projectedFiles, projectedOrder, manualOrder, fileOrder, optimisticMove]);
  const flatRows = useMemo(() => flattenVisible(tree, effectiveExpanded, showRoot, order, (kind, path) => {
    if (kind === "file" && optimisticMove?.kind === "file" && path === optimisticMove.newPath) {
      // The key registry can remap the old path while the overlay still uses this row.
      return optimisticMove.rowId;
    }
    return getExplorerRowKey(kind, path);
  }), [tree, effectiveExpanded, showRoot, order, optimisticMove]);
  // Test seam for the WebKitGTK regression suite: only in Vite DEV and only
  // when the fixture explicitly opts in. It exposes the lifecycle of the
  // optimistic projection without affecting the production bundle.
  if (import.meta.env.DEV && (window as unknown as { __LYRA_DND_TEST__?: boolean }).__LYRA_DND_TEST__) {
    (window as unknown as { __lyraDndState?: unknown }).__lyraDndState = {
      optimisticMove,
      pending: pendingOptimisticMoveRef.current && { ...pendingOptimisticMoveRef.current },
    };
  }

  const expandedRef = useRef(expanded);
  const effectiveExpandedRef = useRef(effectiveExpanded);
  const orderRef = useRef(order);
  const fileOrderRef = useRef(fileOrder);
  const flatRowsRef = useRef(flatRows);
  const tempExpandedRef = useRef(tempExpanded);
  // Props vigentes para decidir cuándo la proyección optimista ya puede retirarse
  // sin reintroducir la ruta de origen (lo que movería las filas de carpeta).
  const filesPropRef = useRef(files);
  const foldersPropRef = useRef(folders);
  filesPropRef.current = files;
  foldersPropRef.current = folders;
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { effectiveExpandedRef.current = effectiveExpanded; }, [effectiveExpanded]);
  useEffect(() => { orderRef.current = order; }, [order]);
  useEffect(() => { fileOrderRef.current = fileOrder; }, [fileOrder]);
  useEffect(() => { flatRowsRef.current = flatRows; }, [flatRows]);
  useEffect(() => { tempExpandedRef.current = tempExpanded; }, [tempExpanded]);

  const settleOptimisticMove = useCallback((move: OptimisticMove) => {
    const pending = pendingOptimisticMoveRef.current;
    if (!pending || pending.kind !== move.kind
      || pending.oldPath !== move.oldPath || pending.newPath !== move.newPath) return false;
    const visible = move.kind === "file" ? filesPropRef.current : foldersPropRef.current;
    // El destino debe estar en las props y la ruta de origen debe haber
    // desaparecido. Como las rutas de hijos también cambian en movimientos de
    // carpeta, basta con comprobar la raíz: el store remapea todos sus
    // descendientes en la misma actualización atómica.
    if (!visible.includes(move.newPath) || visible.includes(move.oldPath)) return false;
    // Y el orden activo debe ser ya el orden definitivo persistido. Si todavía
    // rige el orden intermedio de migratePreferences (destino al final), retirar
    // la proyección reordenaría la fila a espaldas del overlay durante el drop.
    if (!pending.definitiveOrder) return false;
    const activeOrder = pending.orderKey === "fileOrder" ? fileOrderRef.current : orderRef.current;
    if (!sameOrderPaths(activeOrder[pending.parentKey], pending.definitiveOrder[pending.parentKey], move.kind)) return false;
    pendingOptimisticMoveRef.current = null;
    setOptimisticMove(current => (
      current && current.kind === move.kind
        && current.oldPath === move.oldPath && current.newPath === move.newPath ? null : current
    ));
    return true;
  }, []);

  // Red de seguridad: la proyección solo se retira cuando el estado definitivo
  // (props + orden persistido) reproduce exactamente el mismo árbol y orden.
  useEffect(() => {
    const move = optimisticMove;
    if (!move) return;
    settleOptimisticMove(move);
  }, [files, folders, fileOrder, order, optimisticMove, settleOptimisticMove]);

  // Sincronización: las preferencias base se derivan de localStorage por prefTick.
  // Los overrides locales (DnD optimista) se limpian cuando no hay movimiento pendiente.
  useEffect(() => {
    if (!pendingOptimisticMoveRef.current) {
      setOrderOverride(null);
      setFileOrderOverride(null);
    }
  }, [prefTick]);

  function toggle(path: string) {
    if (searchActive) return;
    const id = path || ROOT_FOLDER_ID;
    const current = (expanded[id] ?? true) || !!tempExpanded[path];
    const nextVal = !current;
    if (path) {
      prepareMetadataWrite("folder", path);
      bindMetadataWithFeedback("folder", path);
    }
    const next = { ...expanded, [id]: nextVal };
    if (!nextVal && path && tempExpanded[path]) {
      setTempExpanded(prev => { const n = { ...prev }; delete n[path]; return n; });
    } else if (nextVal && path && tempExpanded[path]) {
      setTempExpanded(prev => { const n = { ...prev }; delete n[path]; return n; });
    }
    setItem("folderExpanded", JSON.stringify(next));
  }

  const setItemRef = useRef(setItem);
  useEffect(() => { setItemRef.current = setItem; }, [setItem]);

  const freshOrder = useCallback((): FolderOrder => readJson("folderOrder", {}), []);
  const freshFileOrder = useCallback((): FolderOrder => readJson("fileOrder", {}), []);
  const applyFolderOrder = useCallback((nextMap: FolderOrder) => {
    const existing = new Set(folders);
    for (const paths of Object.values(nextMap)) for (const path of paths) {
      if (existing.has(path)) bindMetadataWithFeedback("folder", path);
    }
    setOrderOverride(nextMap); setItemRef.current("folderOrder", JSON.stringify(nextMap));
  }, [folders]);
  const applyFileOrder = useCallback((nextMap: FolderOrder) => {
    const existing = new Set(files);
    for (const paths of Object.values(nextMap)) for (const path of paths) {
      if (existing.has(path)) bindMetadataWithFeedback("file", path);
    }
    setFileOrderOverride(nextMap); setItemRef.current("fileOrder", JSON.stringify(nextMap));
  }, [files]);

  const moveEntry = useCallback(async (kind: "file" | "folder", sourcePath: string, destinationPath: string): Promise<boolean> => {
    try {
      await moveLocalPath(kind, sourcePath, destinationPath);
      return true;
    } catch (error) {
      notification("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  // --- Drop execution (reuses existing move/persist/optimistic logic) ---
  const resolveDrop = useCallback(async (item: DragItem, target: DropTarget, reason: "drop" | "cancel"): Promise<string[] | null> => {
    if (reason === "cancel" || !target) return null;

    if (item.kind === "file") {
      const draggedPath = item.path;
      if (target.type === "file-into-folder") {
        const targetDir = target.folderPath; // "" raíz Lyra
        const destinationPath = targetDir ? `${targetDir}/${getFileBaseName(draggedPath)}` : getFileBaseName(draggedPath);
        if (destinationPath === draggedPath) return null;
        const sourceDir = getFileDirectory(draggedPath);
        if (sourceDir === targetDir) {
          // ya está en la carpeta: no-op para "al final" (sin reorden explícito)
          return null;
        }
        const containerKey = targetDir;
        const destFiles = flatRowsRef.current.filter(r => r.open && r.kind === "file" && fileContainerKeyForPath(r.path) === containerKey).map(r => r.path);
        const selectedOrder = insertFileAtVisibleIndex(destFiles, destFiles.length, destinationPath, [draggedPath]);
        const optimisticFileOrder = { ...freshFileOrder(), [containerKey]: selectedOrder };
        const move: OptimisticMove = { kind: "file", rowId: item.id, oldPath: draggedPath, newPath: destinationPath };
        pendingOptimisticMoveRef.current = { ...move, orderKey: "fileOrder", parentKey: containerKey, definitiveOrder: null };
        setFileOrderOverride(optimisticFileOrder);
        setOptimisticMove(move);
        let keepVisualAtDestination = false;
        let success = false;
        try {
          await moveLocalPath("file", draggedPath, destinationPath, selectedOrder);
          const pending = pendingOptimisticMoveRef.current;
          if (pending && pending.oldPath === move.oldPath && pending.newPath === move.newPath) {
            const nextMap = freshFileOrder();
            setFileOrderOverride(nextMap);
            pendingOptimisticMoveRef.current = { ...pending, definitiveOrder: nextMap };
          }
          success = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("move journal was kept for recovery")) {
            keepVisualAtDestination = true;
            success = true;
          } else {
            pendingOptimisticMoveRef.current = null;
            setFileOrderOverride(null);
            setOptimisticMove(null);
          }
          notification("error", message);
        } finally {
          if (!keepVisualAtDestination) settleOptimisticMove(move);
        }
        return success ? (containerKey === "" ? [ROOT_FOLDER_ID] : ancestorsOf(containerKey)) : null;
      }

      if (target.type === "file-insert") {
        const containerKey = target.containerKey;
        const sourceDir = getFileDirectory(draggedPath);
        const isSameContainer = sourceDir === containerKey;
        const containerFiles = flatRowsRef.current
          .filter(r => r.open && r.kind === "file" && fileContainerKeyForPath(r.path) === containerKey)
          .map(r => r.path)
          .filter(p => p !== draggedPath);
        const insertAt = Math.max(0, Math.min(target.index, containerFiles.length));

        if (isSameContainer) {
          if (!(manualOrder || searchStore.getState().sortOption === "manual")) return null;
          const map = freshFileOrder();
          const list = insertFileAtVisibleIndex(containerFiles, insertAt, draggedPath, []);
          applyFileOrder({ ...map, [containerKey]: list });
          return containerKey === "" ? [ROOT_FOLDER_ID] : ancestorsOf(containerKey);
        }

        const destinationPath = containerKey ? `${containerKey}/${getFileBaseName(draggedPath)}` : getFileBaseName(draggedPath);
        if (destinationPath === draggedPath) return null;
        const selectedOrder = target.visiblePaths && !target.visiblePaths.includes(destinationPath)
          ? target.visiblePaths.map(path => path === draggedPath ? destinationPath : path)
          : insertFileAtVisibleIndex(containerFiles, insertAt, destinationPath, [draggedPath]);
        const optimisticFileOrder = { ...freshFileOrder(), [containerKey]: selectedOrder };
        const move: OptimisticMove = { kind: "file", rowId: item.id, oldPath: draggedPath, newPath: destinationPath };
        pendingOptimisticMoveRef.current = { ...move, orderKey: "fileOrder", parentKey: containerKey, definitiveOrder: null };
        setFileOrderOverride(optimisticFileOrder);
        setOptimisticMove(move);
        let keepVisualAtDestination = false;
        let success = false;
        try {
          await moveLocalPath("file", draggedPath, destinationPath, selectedOrder);
          const pending = pendingOptimisticMoveRef.current;
          if (pending && pending.oldPath === move.oldPath && pending.newPath === move.newPath) {
            const nextMap = freshFileOrder();
            setFileOrderOverride(nextMap);
            pendingOptimisticMoveRef.current = { ...pending, definitiveOrder: nextMap };
          }
          success = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("move journal was kept for recovery")) {
            keepVisualAtDestination = true;
            success = true;
          } else {
            pendingOptimisticMoveRef.current = null;
            setFileOrderOverride(null);
            setOptimisticMove(null);
          }
          notification("error", message);
        } finally {
          if (!keepVisualAtDestination) settleOptimisticMove(move);
        }
        return success ? (containerKey === "" ? [ROOT_FOLDER_ID] : ancestorsOf(containerKey)) : null;
      }
      return null;
    }

    // folder drag
    if (item.isRoot) return null;
    if (target.type === "folder-reorder") {
      const draggedPath = item.path;
      const sourceDir = getFileDirectory(draggedPath);
      const sourceKey = sourceDir === "" ? "$top" : sourceDir;
      if (sourceKey !== target.parentKey) return null;
      const siblings = flatRowsRef.current.filter(r => r.open && r.kind === "folder" && !r.isRoot && (getFileDirectory(r.path) || "$top") === target.parentKey).map(r => r.path);
      const map = freshOrder();
      const list = [...(map[target.parentKey] ?? siblings)].filter(p => p !== draggedPath);
      const idx = Math.max(0, Math.min(target.index, list.length));
      list.splice(idx, 0, draggedPath);
      applyFolderOrder({ ...map, [target.parentKey]: list });
      const parentDir = target.parentKey === "$top" ? "" : target.parentKey;
      return parentDir === "" ? [ROOT_FOLDER_ID] : ancestorsOf(parentDir);
    }
    if (target.type === "folder-into") {
      const targetDir = target.targetFolderPath;
      const draggedPath = item.path;
      if (targetDir === draggedPath || (targetDir !== "" && targetDir.startsWith(`${draggedPath}/`))) return null;

      const sourceDir = getFileDirectory(draggedPath);
      const sourceKey = sourceDir === "" ? "$top" : sourceDir;
      const targetKey = targetDir === "" ? "$top" : targetDir;
      const baseName = getFileBaseName(draggedPath);
      const destinationPath = targetDir ? `${targetDir}/${baseName}` : baseName;

      if (sourceKey === targetKey) {
        const siblings = flatRowsRef.current.filter(r => r.open && r.kind === "folder" && !r.isRoot && (getFileDirectory(r.path) || "$top") === targetKey).map(r => r.path);
        const map = freshOrder();
        const list = [...(map[targetKey] ?? siblings)].filter(p => p !== draggedPath);
        list.push(draggedPath);
        applyFolderOrder({ ...map, [targetKey]: list });
        return targetDir === "" ? [ROOT_FOLDER_ID] : ancestorsOf(targetDir);
      }

      if (destinationPath === draggedPath) return null;
      const optimistic: OptimisticMove = { kind: "folder", rowId: item.id, oldPath: draggedPath, newPath: destinationPath };
      pendingOptimisticMoveRef.current = { ...optimistic, orderKey: "folderOrder", parentKey: targetKey, definitiveOrder: null };
      setOptimisticMove(optimistic);
      try {
        if (!(await moveEntry("folder", draggedPath, destinationPath))) {
          pendingOptimisticMoveRef.current = null;
          setOptimisticMove(null);
          return null;
        }
        const map = readJson<FolderOrder>("folderOrder", {});
        const list = [...(map[targetKey] ?? [])].filter(p => p !== destinationPath);
        list.push(destinationPath);
        const nextMap = { ...map, [targetKey]: list };
        setOrderOverride(nextMap);
        await persistOrderAfterPhysicalMove("folderOrder", nextMap);
        const pending = pendingOptimisticMoveRef.current;
        if (pending && pending.oldPath === optimistic.oldPath && pending.newPath === optimistic.newPath) {
          pendingOptimisticMoveRef.current = { ...pending, definitiveOrder: nextMap };
        }
        return targetDir === "" ? [ROOT_FOLDER_ID] : ancestorsOf(targetDir);
      } finally {
        // Igual que en los archivos: retirar la proyección solo cuando la
        // carpeta destino ya está en las props evita un salto intermedio.
        settleOptimisticMove(optimistic);
      }
    }
    return null;
  }, [applyFileOrder, applyFolderOrder, freshFileOrder, freshOrder, manualOrder, moveEntry, settleOptimisticMove]);

  const handleDragEndCleanup = useCallback((keepExpandedPaths: string[] | null, _cancelled: boolean) => {
    if (keepExpandedPaths && keepExpandedPaths.length > 0) {
      if (!searchActive) {
        const toKeep = new Set(keepExpandedPaths.filter(Boolean));
        const baseExpanded = readFolderExpandedState(window.localStorage);
        const nextExpanded = { ...baseExpanded, ...expandedRef.current };
        let changed = false;
        for (const p of toKeep) {
          if (!nextExpanded[p]) { nextExpanded[p] = true; changed = true; }
        }
        if (changed) {
          setItem("folderExpanded", JSON.stringify(nextExpanded));
        }
      }
      setTempExpanded({});
    } else {
      setTempExpanded({});
    }
  }, [setItem, searchActive]);

  const dragRowRef = useRef<FlatRow | null>(null);
  const dropPlacementRef = useRef<string | null>(null);
  const dropOverlayRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const dropReadyRef = useRef<Promise<void> | null>(null);
  const releaseDropRef = useRef<(() => void) | null>(null);
  const dropAnimationRef = useRef<Promise<void> | null>(null);
  const captureFrameRef = useRef<number | null>(null);
  const animateDrop = useCallback(({ element, feedbackElement }: { element: Element; feedbackElement: Element }) => {
    if (dropAnimationRef.current) return dropAnimationRef.current;
    const run = async () => {
      await dropReadyRef.current;
      const path = dropPlacementRef.current ?? dragRowRef.current?.path;
      const findRow = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-explorer-row-kind="file"]') ?? [])]
        .find(row => row.dataset.explorerPath === path);
      let target = findRow();
      if (!target && path && listRef.current) {
        target = await new Promise<HTMLElement>(resolve => {
          const observer = new MutationObserver(() => {
            const row = findRow();
            if (row) { observer.disconnect(); resolve(row); }
          });
          observer.observe(listRef.current!, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-explorer-path"] });
        });
      }
      const finalElement = target ?? (element.isConnected ? element : null);
      if (!finalElement) return;
      const current = feedbackElement.getBoundingClientRect();
      const release = dropOverlayRectRef.current ?? current;
      const final = finalElement.getBoundingClientRect();
      // dnd-kit can restore its inline translate before invoking dropAnimation.
      const translate = getComputedStyle(feedbackElement).translate;
      const [translateX, translateY] = translate === "none" ? [0, 0] : translate.split(/\s+/).map(Number.parseFloat);
      const baseX = current.x - (translateX || 0);
      const baseY = current.y - (translateY || 0);
      if (feedbackElement instanceof HTMLElement && feedbackElement.hasAttribute("popover") && !feedbackElement.matches(":popover-open")) {
        feedbackElement.showPopover();
      }
      feedbackElement.setAttribute("data-dnd-dropping", "");
      const animation = feedbackElement.animate([
        { translate: `${release.x - baseX}px ${release.y - baseY}px 0`, minWidth: `${release.width}px`, maxWidth: `${release.width}px`, minHeight: `${release.height}px`, maxHeight: `${release.height}px` },
        { translate: `${final.x - baseX}px ${final.y - baseY}px 0`, minWidth: `${final.width}px`, maxWidth: `${final.width}px`, minHeight: `${final.height}px`, maxHeight: `${final.height}px` },
      ], { duration: noAnim ? 0 : 190, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      try { await animation.finished; } finally { feedbackElement.removeAttribute("data-dnd-dropping"); }
    };
    dropAnimationRef.current = run();
    return dropAnimationRef.current;
  }, [noAnim]);
  useEffect(() => () => {
    if (captureFrameRef.current !== null) cancelAnimationFrame(captureFrameRef.current);
    releaseDropRef.current?.();
  }, []);
  const folderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverFolderRef = useRef<string | null>(null);
  const clickBlockUntilRef = useRef(0);
  const dropScrollCleanupRef = useRef<(() => void) | null>(null);
  const stopDropScrollLock = useCallback(() => {
    dropScrollCleanupRef.current?.();
    dropScrollCleanupRef.current = null;
  }, []);
  useEffect(() => stopDropScrollLock, [stopDropScrollLock]);
  // AutoScroller can leave a scheduled frame after disable(); preserve the release position until dnd-kit finishes placement.
  const lockDropScroll = useCallback((source: { status: string } | null) => {
    stopDropScrollLock();
    const container = listRef.current?.closest<HTMLElement>("#lyra-list-scroll-container, [data-explorer-scroll]");
    if (!container || !source) return;
    const position = container.scrollTop;
    let frame = 0;
    const restore = () => {
      const validPosition = Math.min(position, Math.max(0, container.scrollHeight - container.clientHeight));
      if (container.scrollTop !== validPosition) container.scrollTop = validPosition;
    };
    const watch = () => {
      restore();
      if (source.status === "idle") stopDropScrollLock();
      else frame = requestAnimationFrame(watch);
    };
    container.addEventListener("scroll", restore, { passive: true });
    frame = requestAnimationFrame(watch);
    dropScrollCleanupRef.current = () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", restore);
    };
  }, [stopDropScrollLock]);
  const clearFolderTimer = useCallback(() => {
    if (folderTimerRef.current) clearTimeout(folderTimerRef.current);
    folderTimerRef.current = null;
  }, []);
  useEffect(() => clearFolderTimer, [clearFolderTimer]);

  const onModernDragOver = useCallback((targetId: string | number | undefined) => {
    const id = typeof targetId === "string" && targetId.startsWith("drop-folder:")
      ? targetId.slice("drop-folder:".length) : null;
    if (id === hoverFolderRef.current) return;
    clearFolderTimer();
    hoverFolderRef.current = id;
    if (!id) return;
    const folder = flatRowsRef.current.find(row => row.id === id && row.kind === "folder");
    if (!folder) return;
    const key = folder.isRoot ? ROOT_FOLDER_ID : folder.path;
    if (effectiveExpandedRef.current[key] ?? true) return;
    folderTimerRef.current = setTimeout(() => {
      setTempExpanded(prev => ({ ...prev, [key]: true }));
      folderTimerRef.current = null;
    }, 500);
  }, [clearFolderTimer]);

  // Estado de expansión efectivo para renderizado (proyección temporal durante búsqueda).
  const effectiveForRender = effectiveExpanded;

  // --- render helpers ---
  const stagger = useMemo(() => {
    const indices = new Map<string, { index: number; total: number }>();
    const groups = new Map<string, string[]>();
    for (const row of flatRows) {
      if (row.isRoot) continue;
      const key = row.kind === "folder"
        ? `f:${getFileDirectory(row.path) || "$top"}`
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

  function rowInnerTransition(row: FlatRow) {
    const info = stagger.get(row.id);
    const delay = noAnim || !info || info.total <= 1 ? 0 : (info.index / (info.total - 1)) * STAGGER_SPREAD;
    if (noAnim) return { duration: 0 };
    return {
      duration: ITEM_DURATION,
      delay,
      ease: EASING,
      opacity: { duration: FOLD_DURATION, ease: EASING },
      visibility: { duration: 0, delay: row.open ? 0 : FOLD_DURATION },
    };
  }
  const heightTransition = noAnim ? { duration: 0 } : { duration: FOLD_DURATION, ease: EASING };

  function renderRowInner(row: FlatRow): ReactNode {
    const open = row.open;
    const transition = rowInnerTransition(row);
    if (row.kind === "folder") {
      const isRoot = row.isRoot;
      const depth = row.depth;
      const selfKey = isRoot ? ROOT_FOLDER_ID : row.path;
      const selfOpen = effectiveForRender[selfKey] ?? (expanded[selfKey] ?? true);
      const textColor = resolveFolderColor(folderTextColors[row.path], isDay);
      const iconColor = resolveFolderColor(folderIconColors[row.path], isDay);
      const iconKey = folderIcons[row.path];
      const RowFolderIcon = resolveFolderIcon(iconKey);
      const folderLabel = displayFolderName(row.path);
      const folderContent = (
        <div className="flex items-center">
          <button type="button" onClick={() => toggle(row.path)} aria-expanded={selfOpen}
            className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left text-sm font-medium hover:text-sky-400 outline-none focus:outline-none focus-visible:outline-none"
            style={{ paddingLeft: depth * 20, ...(textColor ? { color: textColor } : {}) }}>
            <motion.span initial={false} animate={{ rotate: selfOpen ? 90 : 0 }} transition={heightTransition}
              style={iconColor ? { color: iconColor } : undefined} className="flex items-center">
              <ChevronRight size={16} />
            </motion.span>
            <RowFolderIcon size={17} style={iconColor ? { color: iconColor } : undefined} />
            <span data-explorer-name className="truncate" style={textColor ? { color: textColor } : undefined}>{folderLabel}</span>
          </button>
          {(() => {
            const inArchivedView = archivedPaths.length > 0 || !showRoot;
            if (!inArchivedView) {
              return <FolderMenu path={row.path} archived={false} structural={false} folderArchiveKind="active" />;
            }
            const kind = classifyArchivedViewFolder(row.path, archivedPaths);
            return <FolderMenu path={row.path} archived={kind !== "structural"} structural={kind === "structural"} folderArchiveKind={kind} />;
          })()}
        </div>
      );
      return (
        <motion.div initial={false} animate={{ height: open ? "auto" : 0 }} transition={heightTransition} style={{ overflow: "hidden" }} className="motion-reduce:transition-none">
          <motion.div initial={false} aria-hidden={!open}
            animate={open ? { y: 0, opacity: 1, visibility: "visible" } : { y: CLOSED_Y, opacity: 0, visibility: "hidden" }}
            transition={transition} style={{ pointerEvents: open ? "auto" : "none" }} className="motion-reduce:transition-none">
            {folderContent}
          </motion.div>
        </motion.div>
      );
    }
    return (
      <motion.div initial={false} animate={{ height: open ? "auto" : 0 }} transition={heightTransition} style={{ overflow: "hidden" }} className="motion-reduce:transition-none">
        <motion.div initial={false} aria-hidden={!open}
          animate={open ? { y: 0, opacity: 1, visibility: "visible" } : { y: CLOSED_Y, opacity: 0, visibility: "hidden" }}
          transition={transition} style={{ pointerEvents: open ? "auto" : "none" }} className="motion-reduce:transition-none">
          {renderFile(row.path, row.depth)}
        </motion.div>
      </motion.div>
    );
  }

  if (!dndEnabled || searchActive) {
    return (
      <div ref={listRef} className="flex flex-col w-[680px] max-w-full pb-20 animate-list-switch" role="list">
        {flatRows.map(row => (
          <div key={row.id} role="listitem" data-explorer-row-id={row.id} data-explorer-row-kind={row.kind} data-explorer-path={row.path} data-open={row.open ? "1" : "0"}>
            {renderRowInner(row)}
          </div>
        ))}
      </div>
    );
  }

  const fileIndices = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const row of flatRows) {
    if (row.kind === "file") {
      const group = fileContainerKeyForPath(row.path);
      const index = groupCounts.get(group) ?? 0;
      fileIndices.set(row.id, index);
      groupCounts.set(group, index + 1);
    }
  }

  return (
    <DragDropProvider
      sensors={defaults => [...defaults.filter(sensor => sensor !== PointerSensor), PointerSensor.configure({
        activationConstraints: [
          new PointerActivationConstraints.Distance({ value: 8 }),
          new PointerActivationConstraints.Delay({ value: 150, tolerance: 12 }),
        ],
        preventActivation: event => event.target instanceof Element
          && event.target.closest("button, a, input, select, textarea, [role='button'], [data-no-drag]") !== null,
      })]}
      onDragStart={(event, manager) => {
        stopDropScrollLock();
        dropPlacementRef.current = null;
        dropOverlayRectRef.current = null;
        dropAnimationRef.current = null;
        dropReadyRef.current = new Promise(resolve => { releaseDropRef.current = resolve; });
        if (captureFrameRef.current !== null) cancelAnimationFrame(captureFrameRef.current);
        const captureDragRect = () => {
          const overlay = document.querySelector<HTMLElement>("[data-dnd-overlay]");
          const rect = overlay?.getBoundingClientRect();
          if (rect?.width && getComputedStyle(overlay!).translate !== "none") {
            dropOverlayRectRef.current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }
          captureFrameRef.current = requestAnimationFrame(captureDragRect);
        };
        captureFrameRef.current = requestAnimationFrame(captureDragRect);
        manager.registry.plugins.get(AutoScroller)?.enable();
        const row = flatRowsRef.current.find(candidate => candidate.id === event.operation.source?.id);
        dragRowRef.current = row?.kind === "file" ? row : null;
        // La activación real del arrastre convierte el orden visible en orden manual.
        // Se hace antes de cualquier movimiento para que no exista un fotograma reordenado.
        if (row?.kind === "file" && searchStore.getState().sortOption !== "manual") {
          searchStore.getState().setSortOption("manual");
        }
      }}
      onDragOver={event => {
        onModernDragOver(event.operation.target?.id);
        const row = dragRowRef.current;
        if (!row) return;
        const targetId = event.operation.target?.id;
        if (typeof targetId === "string" && targetId.startsWith("drop-folder:")) {
          const folder = flatRowsRef.current.find(candidate => folderDropId(candidate.id) === targetId);
          if (folder?.kind === "folder" && folder.open) {
            dropPlacementRef.current = folder.path ? `${folder.path}/${getFileBaseName(row.path)}` : getFileBaseName(row.path);
          }
        } else if (isSortable(event.operation.source)) {
          const group = event.operation.source.group;
          dropPlacementRef.current = group ? `${group}/${getFileBaseName(row.path)}` : getFileBaseName(row.path);
        }
      }}
      onDragEnd={(event, manager) => {
        if (captureFrameRef.current !== null) cancelAnimationFrame(captureFrameRef.current);
        captureFrameRef.current = null;
        const overlay = document.querySelector<HTMLElement>("[data-dnd-overlay]");
        const rect = overlay?.getBoundingClientRect();
        if (!dropOverlayRectRef.current && rect && rect.width > 0) {
          dropOverlayRectRef.current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
        releaseDropRef.current?.();
        releaseDropRef.current = null;
        const source = event.operation.source;
        const sourceGroup = isSortable(source) ? source.group : undefined;
        const sourceIndex = isSortable(source) ? source.index : undefined;
        const initialGroup = isSortable(source) ? source.initialGroup : undefined;
        const initialIndex = isSortable(source) ? source.initialIndex : undefined;
        const targetId = event.operation.target?.id;
        const hasTarget = Boolean(event.operation.target);
        manager.registry.plugins.get(AutoScroller)?.disable();
        lockDropScroll(event.operation.source);
        clearFolderTimer(); hoverFolderRef.current = null;
        clickBlockUntilRef.current = Date.now() + 350;
        const row = dragRowRef.current;
        if (event.canceled || !row || !isSortable(source)
          || initialGroup !== getFileDirectory(row.path)) {
          dropPlacementRef.current = row?.path ?? null;
          handleDragEndCleanup(null, true);
          return;
        }
        let target: DropTarget = null;
        if (typeof targetId === "string" && targetId.startsWith("drop-folder:")) {
          const folder = flatRowsRef.current.find(candidate => folderDropId(candidate.id) === targetId);
          if (folder?.kind === "folder" && folder.open) target = { type: "file-into-folder", folderPath: folder.path };
        } else if (hasTarget && typeof sourceGroup === "string" && typeof sourceIndex === "number") {
          // A listing update can change the visible slot without updating the source's sortable index.
          const visiblePaths = sourceGroup !== initialGroup && listRef.current
            ? readVisibleFilePlacement(listRef.current, row.id, sourceGroup)
            : undefined;
          target = { type: "file-insert", containerKey: sourceGroup, index: sourceIndex, visiblePaths };
        }
        if (!target) {
          dropPlacementRef.current = row.path;
          handleDragEndCleanup(null, true);
          return;
        }
        if (target.type === "file-insert" && initialGroup === sourceGroup
          && initialIndex === sourceIndex) {
          dropPlacementRef.current = row.path;
          handleDragEndCleanup(null, false);
          return;
        }
        const item: DragItem = { kind: "file", id: row.id, path: row.path, isRoot: false };
        const destinationPath = target.type === "file-into-folder"
          ? target.folderPath ? `${target.folderPath}/${getFileBaseName(row.path)}` : getFileBaseName(row.path)
          : target.containerKey ? `${target.containerKey}/${getFileBaseName(row.path)}` : getFileBaseName(row.path);
        dropPlacementRef.current = destinationPath;
        // Commit the cross-folder projection outside dnd-kit's React transition.
        // An urgent render could otherwise restore the old tree over the sorted DOM.
        const result = destinationPath === row.path
          ? resolveDrop(item, target, "drop")
          : flushSync(() => resolveDrop(item, target, "drop"));
        void result
          .then(keep => handleDragEndCleanup(keep, false))
          .catch(error => {
            notification("error", error instanceof Error ? error.message : String(error));
            handleDragEndCleanup(null, true);
          });
      }}
    >
      <div ref={listRef} onClickCapture={event => {
        if (Date.now() < clickBlockUntilRef.current) { event.preventDefault(); event.stopPropagation(); }
      }} className="flex flex-col w-[680px] max-w-full pb-20 animate-list-switch" role="list">
        {flatRows.map(row => row.kind === "folder" ? (
          <DroppableFolderRow key={row.id} row={row}>{renderRowInner(row)}</DroppableFolderRow>
        ) : (
          <SortableFileRow key={row.id} row={row} group={fileContainerKeyForPath(row.path)}
            index={fileIndices.get(row.id)!} enabled={row.open} reducedMotion={noAnim}>
            {renderRowInner(row)}
          </SortableFileRow>
        ))}
      </div>
      <DndDragOverlay dropAnimation={animateDrop}>
        {source => {
          const row = flatRows.find(candidate => candidate.id === source.id && candidate.kind === "file") ?? dragRowRef.current;
          return row ? <div className="w-full rounded-md bg-zinc-800/95 shadow-xl motion-reduce:transition-none"
            style={{ paddingLeft: row.depth * 20, transition: noAnim ? "none" : "padding-left 190ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
            {renderFile(row.path, 0)}
          </div> : null;
        }}
      </DndDragOverlay>
    </DragDropProvider>
  );
}
