import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ChevronDown, ChevronRight, Folder as FolderIcon } from "lucide-react";
import useStorage from "../hooks/useStorage.ts";
import { buildFolderTree, readFolderExpandedState, ROOT_FOLDER_ID, type FolderOrder } from "../utils/folderTree.ts";
import { flattenVisible, type FlatRow } from "../utils/flattenExplorer.ts";
import { getExplorerRowKey } from "../utils/explorerKeys.ts";
import FolderMenu from "./FolderMenu.tsx";
import { moveLocalPath } from "../utils/pathOperations.ts";
import { persistOrderAfterPhysicalMove } from "../utils/persistAfterPhysicalMove.ts";
import { getFileBaseName, getFileDirectory } from "../utils/noteName.ts";
import { notification } from "../utils/helpers.ts";
import { configStore } from "../store/configStore.ts";
import { ancestorsOf } from "../utils/dndExpansion.ts";
import { EXPLORER_DND_ENABLED } from "../dnd-explorer/config.ts";
import { getFolderColors, getFolderIcons, resolveFolderColor, resolveFolderIcon } from "../utils/folderAppearance.ts";
import { displayFolderName } from "../utils/visibleNames.ts";
import { themes } from "../utils/helpers.ts";
import { useExplorerDnd } from "../dnd-explorer/useExplorerDnd.ts";
import type { DragItem, DropTarget } from "../dnd-explorer/types.ts";
import DragOverlay from "../dnd-explorer/DragOverlay.tsx";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

const EASING: [number, number, number, number] = [0.32, 0.72, 0.35, 1];
const ITEM_DURATION = 0.32;
const CLOSED_Y = -36;
const STAGGER_SPREAD = 0.18;

function fileContainerKeyForPath(path: string): string {
  return getFileDirectory(path);
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
  const { isDay } = themes();
  const [tempExpanded, setTempExpanded] = useState<Record<string, boolean>>({});
  const [optimisticMove, setOptimisticMove] = useState<{ kind: "file" | "folder"; oldPath: string; newPath: string } | null>(null);
  const pendingOptimisticMoveRef = useRef<{ kind: "file" | "folder"; oldPath: string; newPath: string } | null>(null);
  const prefTick = configStore(state => state.prefTick);
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
  const order = orderOverride ?? storedOrder;
  const fileOrder = fileOrderOverride ?? storedFileOrder;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read localStorage appearance maps on preference changes
  const folderColors = useMemo(() => getFolderColors(), [prefTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read localStorage appearance maps on preference changes
  const folderIcons = useMemo(() => getFolderIcons(), [prefTick]);
  const [reducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const noAnim = reducedMotion;
  const dndEnabled = EXPLORER_DND_ENABLED && archivedPaths.length === 0;
  const filesDraggable = dndEnabled && manualOrder;

  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);

  const effectiveExpanded = useMemo(() => ({ ...expanded, ...tempExpanded }), [expanded, tempExpanded]);

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

  const tree = useMemo(() => buildFolderTree(projectedFolders, projectedFiles, projectedOrder, manualOrder ? fileOrder : undefined), [projectedFolders, projectedFiles, projectedOrder, manualOrder, fileOrder]);
  const flatRows = useMemo(() => flattenVisible(tree, effectiveExpanded, showRoot, order, getExplorerRowKey), [tree, effectiveExpanded, showRoot, order]);

  const expandedRef = useRef(expanded);
  const effectiveExpandedRef = useRef(effectiveExpanded);
  const orderRef = useRef(order);
  const fileOrderRef = useRef(fileOrder);
  const flatRowsRef = useRef(flatRows);
  const tempExpandedRef = useRef(tempExpanded);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { effectiveExpandedRef.current = effectiveExpanded; }, [effectiveExpanded]);
  useEffect(() => { orderRef.current = order; }, [order]);
  useEffect(() => { fileOrderRef.current = fileOrder; }, [fileOrder]);
  useEffect(() => { flatRowsRef.current = flatRows; }, [flatRows]);
  useEffect(() => { tempExpandedRef.current = tempExpanded; }, [tempExpanded]);

  // Sincronización: las preferencias base se derivan de localStorage por prefTick.
  // Los overrides locales (DnD optimista) se limpian cuando no hay movimiento pendiente.
  useEffect(() => {
    if (!pendingOptimisticMoveRef.current) {
      setOrderOverride(null);
      setFileOrderOverride(null);
    }
  }, [prefTick]);

  // resolve scroll container once
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    scrollContainerRef.current = el.closest("[data-explorer-scroll]") as HTMLElement | null ?? el.parentElement;
  }, []);

  function toggle(path: string) {
    const id = path || ROOT_FOLDER_ID;
    const current = (expanded[id] ?? true) || !!tempExpanded[path];
    const nextVal = !current;
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
  const applyFolderOrder = useCallback((nextMap: FolderOrder) => { setOrderOverride(nextMap); setItemRef.current("folderOrder", JSON.stringify(nextMap)); }, []);
  const applyFileOrder = useCallback((nextMap: FolderOrder) => { setFileOrderOverride(nextMap); setItemRef.current("fileOrder", JSON.stringify(nextMap)); }, []);

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
        const optimisticFileOrder = (() => {
          const map = freshFileOrder();
          const list = [...(map[containerKey] ?? destFiles)].filter(p => p !== draggedPath && p !== destinationPath);
          list.push(destinationPath);
          return { ...map, [containerKey]: list };
        })();
        pendingOptimisticMoveRef.current = { kind: "file", oldPath: draggedPath, newPath: destinationPath };
        setFileOrderOverride(optimisticFileOrder);
        setOptimisticMove({ kind: "file", oldPath: draggedPath, newPath: destinationPath });
        let keepVisualAtDestination = false;
        let success = false;
        try {
          await moveLocalPath("file", draggedPath, destinationPath);
          const map = readJson<FolderOrder>("fileOrder", {});
          const list = [...(map[containerKey] ?? [])].filter(p => p !== destinationPath);
          list.push(destinationPath);
          const nextMap = { ...map, [containerKey]: list };
          setFileOrderOverride(nextMap);
          await persistOrderAfterPhysicalMove("fileOrder", nextMap);
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
          if (!keepVisualAtDestination) {
            pendingOptimisticMoveRef.current = null;
            setOptimisticMove(current => (current && current.oldPath === draggedPath && current.newPath === destinationPath ? null : current));
          }
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
        const refPath = containerFiles[insertAt];

        if (isSameContainer) {
          if (!manualOrder) return null;
          const map = freshFileOrder();
          const list = [...(map[containerKey] ?? containerFiles)].filter(p => p !== draggedPath);
          const idx = refPath ? list.indexOf(refPath) : list.length;
          list.splice(idx >= 0 ? idx : list.length, 0, draggedPath);
          applyFileOrder({ ...map, [containerKey]: list });
          return containerKey === "" ? [ROOT_FOLDER_ID] : ancestorsOf(containerKey);
        }

        const destinationPath = containerKey ? `${containerKey}/${getFileBaseName(draggedPath)}` : getFileBaseName(draggedPath);
        if (destinationPath === draggedPath) return null;
        const optimisticFileOrder = (() => {
          const map = freshFileOrder();
          const list = [...(map[containerKey] ?? containerFiles)].filter(p => p !== draggedPath && p !== destinationPath);
          const idx = refPath ? list.indexOf(refPath) : list.length;
          list.splice(idx >= 0 ? idx : list.length, 0, destinationPath);
          return { ...map, [containerKey]: list };
        })();
        pendingOptimisticMoveRef.current = { kind: "file", oldPath: draggedPath, newPath: destinationPath };
        setFileOrderOverride(optimisticFileOrder);
        setOptimisticMove({ kind: "file", oldPath: draggedPath, newPath: destinationPath });
        let keepVisualAtDestination = false;
        let success = false;
        try {
          await moveLocalPath("file", draggedPath, destinationPath);
          const map = readJson<FolderOrder>("fileOrder", {});
          const list = [...(map[containerKey] ?? [])].filter(p => p !== destinationPath);
          const idx = refPath ? list.indexOf(refPath) : list.length;
          list.splice(idx >= 0 ? idx : list.length, 0, destinationPath);
          const nextMap = { ...map, [containerKey]: list };
          setFileOrderOverride(nextMap);
          await persistOrderAfterPhysicalMove("fileOrder", nextMap);
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
          if (!keepVisualAtDestination) {
            pendingOptimisticMoveRef.current = null;
            setOptimisticMove(current => (current && current.oldPath === draggedPath && current.newPath === destinationPath ? null : current));
          }
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
      const optimistic = { kind: "folder" as const, oldPath: draggedPath, newPath: destinationPath };
      pendingOptimisticMoveRef.current = optimistic;
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
        return targetDir === "" ? [ROOT_FOLDER_ID] : ancestorsOf(targetDir);
      } finally {
        pendingOptimisticMoveRef.current = null;
        setOptimisticMove(current => (current && current.oldPath === draggedPath && current.newPath === destinationPath ? null : current));
      }
    }
    return null;
  }, [applyFileOrder, applyFolderOrder, freshFileOrder, freshOrder, manualOrder, moveEntry]);

  const handleDragEndCleanup = useCallback((keepExpandedPaths: string[] | null, _cancelled: boolean) => {
    if (keepExpandedPaths && keepExpandedPaths.length > 0) {
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
      setTempExpanded({});
    } else {
      setTempExpanded({});
    }
  }, [setItem]);

  const [dragActive, setDragActive] = useState<{ kind: "file" | "folder"; id: string } | null>(null);

  const { dnd, onPointerDownRow, onClickCapture } = useExplorerDnd({
    rootRef: listRef,
    scrollRef: scrollContainerRef,
    enabled: dndEnabled,
    manualOrder,
    canDragFolders: dndEnabled,
    isEffectivelyExpanded: (path, isRoot) => isRoot ? (effectiveExpandedRef.current[ROOT_FOLDER_ID] ?? true) : !!effectiveExpandedRef.current[path],
    requestTempExpand: (path, isRoot) => {
      setTempExpanded(prev => ({ ...prev, [isRoot ? ROOT_FOLDER_ID : path]: true }));
    },
    onDrop: resolveDrop,
    onDragEnd: handleDragEndCleanup,
    onDragActiveChange: (kind, id) => setDragActive(kind && id ? { kind, id } : null),
  });

  // effective expanded including temp root key
  const effectiveForRender = useMemo(() => ({ ...expanded, ...tempExpanded }), [expanded, tempExpanded]);

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
      const depth = row.depth;
      const selfKey = isRoot ? ROOT_FOLDER_ID : row.path;
      const selfOpen = effectiveForRender[selfKey] ?? (expanded[selfKey] ?? true);
      const colorKey = !isRoot ? folderColors[row.path] : undefined;
      const iconKey = !isRoot ? folderIcons[row.path] : undefined;
      const folderColor = resolveFolderColor(colorKey, isDay);
      const RowFolderIcon = !isRoot ? resolveFolderIcon(iconKey) : FolderIcon;
      const folderContent = (
        <div className="flex items-center">
          <button type="button" onClick={() => toggle(row.path)} aria-expanded={selfOpen}
            className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left text-sm font-medium hover:text-sky-400 outline-none focus:outline-none focus-visible:outline-none"
            style={{ paddingLeft: depth * 20, color: folderColor }}>
            <span style={folderColor ? { color: folderColor } : undefined} className="flex items-center">
              {selfOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
            <RowFolderIcon size={17} style={folderColor ? { color: folderColor } : undefined} />
            <span className="truncate" style={folderColor ? { color: folderColor } : undefined}>{isRoot ? "Lyra (carpeta)" : displayFolderName(row.path)}</span>
          </button>
          <FolderMenu path={row.path} archived={archivedPaths.includes(row.path)} structural={!showRoot && !archivedPaths.includes(row.path)} />
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

  const draggedId = dragActive?.id ?? null;
  const insertTarget = (dnd.dropTarget && dnd.dropTarget.type === "file-insert") ? dnd.dropTarget : null;

  function renderFileBlock(containerKey: string, rows: FlatRow[]): ReactNode {
    const droppableId = `files:${containerKey}`;
    const insertIndex = insertTarget && insertTarget.containerKey === containerKey ? insertTarget.index : null;
    const gapHeight = dnd.cloneSize?.height ?? 44;
    const hasDraggedInBlock = draggedId !== null && rows.some(r => r.id === draggedId);
    // Preserve source space to prevent layout shifts, but avoid doubling space when insertion gap is in this same container.
    const insertInThisContainer = insertIndex !== null && dragActive?.kind === "file";
    const showSourcePlaceholder = hasDraggedInBlock && dragActive?.kind === "file" && !insertInThisContainer;

    // build display sequence preserving source space: iterate original rows in order
    // index for insertion gap is "index in items without dragged" (matches geometry)
    let visIdx = 0;
    const items: ReactNode[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const isDragged = row.id === draggedId;
      if (isDragged) {
        if (showSourcePlaceholder) {
          items.push(
            <div key={`${row.id}:source-placeholder`} aria-hidden="true" style={{ height: gapHeight, borderRadius: 8 }} />
          );
        }
        continue;
      }
      if (insertIndex !== null && visIdx === insertIndex && dragActive?.kind === "file") {
        items.push(
          <motion.div key={`${droppableId}:gap:${visIdx}`} layout initial={{ height: 0, opacity: 0 }} animate={{ height: gapHeight, opacity: 0.18 }} transition={{ duration: 0.18, ease: EASING }}
            style={{ borderRadius: 8, margin: "2px 0", background: "rgba(56,189,248,0.18)" }} aria-hidden="true" />
        );
      }
      items.push(
        <div key={row.id}
          data-explorer-row-id={row.id}
          data-explorer-row-kind="file"
          data-explorer-path={row.path}
          data-open={row.open ? "1" : "0"}
          role="listitem"
          onPointerDown={(e) => filesDraggable && row.open && onPointerDownRow(e, row.id)}
          className={`relative outline-none focus:outline-none focus-visible:outline-none ${filesDraggable && row.open ? "cursor-grab active:cursor-grabbing" : ""}`}
        >
          {renderRowInner(row)}
        </div>
      );
      visIdx++;
    }
    if (insertIndex !== null && insertIndex >= visIdx && dragActive?.kind === "file") {
      items.push(
        <motion.div key={`${droppableId}:gap:end`} layout initial={{ height: 0, opacity: 0 }} animate={{ height: gapHeight, opacity: 0.18 }} transition={{ duration: 0.18, ease: EASING }}
          style={{ borderRadius: 8, margin: "2px 0", background: "rgba(56,189,248,0.18)" }} aria-hidden="true" />
      );
    }

    const isEmptyDropTarget = rows.length === 0 && insertIndex === null;
    return (
      <div key={droppableId} data-file-droppable={containerKey} className="flex flex-col" style={{ minHeight: isEmptyDropTarget ? 28 : undefined }}>
        {items}
      </div>
    );
  }

  function renderFolderRow(row: FlatRow): ReactNode {
    const selfKey = row.isRoot ? ROOT_FOLDER_ID : row.path;
    const selfOpen = effectiveForRender[selfKey] ?? (expanded[selfKey] ?? true);
    const isFolderHover = dnd.folderHoverPath === row.path && dragActive !== null;
    const canDrag = dndEnabled && !row.isRoot && row.open;
    const draggingThis = draggedId === row.id;
    return (
      <div key={row.id} className="flex flex-col">
        <div
          data-explorer-row-id={row.id}
          data-explorer-row-kind="folder"
          data-explorer-path={row.path}
          data-folder-path={row.path}
          data-folder-open={selfOpen ? "1" : "0"}
          data-open={row.open ? "1" : "0"}
          role="listitem"
          onPointerDown={(e) => canDrag && onPointerDownRow(e, row.id)}
          className={`relative outline-none focus:outline-none focus-visible:outline-none ${canDrag ? "cursor-grab active:cursor-grabbing" : ""} ${isFolderHover ? "bg-sky-500/10 rounded-md" : ""}`}
          style={{ opacity: draggingThis ? 0.3 : 1 }}
        >
          {renderRowInner(row)}
        </div>
      </div>
    );
  }

  // Segmentación estable
  const segments = useMemo(() => {
    const base: Array<{ kind: "folder"; row: FlatRow } | { kind: "files"; containerKey: string; rows: FlatRow[] }> = [];
    let i = 0;
    while (i < flatRows.length) {
      const row = flatRows[i];
      if (row.kind === "folder") {
        base.push({ kind: "folder", row });
        i++;
      } else {
        const containerKey = fileContainerKeyForPath(row.path);
        const rows: FlatRow[] = [];
        while (i < flatRows.length && flatRows[i].kind === "file" && fileContainerKeyForPath(flatRows[i].path) === containerKey) {
          rows.push(flatRows[i]);
          i++;
        }
        base.push({ kind: "files", containerKey, rows });
      }
    }
    const fileSegKeys = new Set(base.filter(s => s.kind === "files").map(s => s.containerKey));
    const segs: typeof base = [];
    for (const seg of base) {
      segs.push(seg);
      if (seg.kind === "folder") {
        const selfKey = seg.row.isRoot ? ROOT_FOLDER_ID : seg.row.path;
        const selfOpen = (effectiveForRender[selfKey] ?? (expanded[selfKey] ?? true)) && seg.row.open;
        const containerKey = seg.row.path; // "" for root
        if (selfOpen && !fileSegKeys.has(containerKey)) {
          segs.push({ kind: "files", containerKey, rows: [] });
          fileSegKeys.add(containerKey);
        }
      }
    }
    // If root not shown (archived view), still ensure root-like container exists? not needed.
    return segs;
  }, [expanded, effectiveForRender, flatRows]);

  // Clone content for overlay
  const draggedRow = draggedId ? flatRows.find(r => r.id === draggedId) : null;
  const cloneContent = draggedRow ? (
    <div className="w-full h-full" style={{ opacity: 0.98 }}>
      {/* Render row content in open/visible state for clone */}
      {draggedRow.kind === "folder" ? (() => {
        const cKey = !draggedRow.isRoot ? folderColors[draggedRow.path] : undefined;
        const iKey = !draggedRow.isRoot ? folderIcons[draggedRow.path] : undefined;
        const c = resolveFolderColor(cKey, isDay);
        const DIcon = !draggedRow.isRoot ? resolveFolderIcon(iKey) : FolderIcon;
        return (
        <div className="flex items-center py-3 text-sm font-medium" style={{ paddingLeft: draggedRow.depth * 20, color: c }}>
          <span className="flex items-center gap-2 min-w-0">
            {(effectiveForRender[draggedRow.path || ROOT_FOLDER_ID] ?? true) ? <ChevronDown size={16} style={c ? { color: c } : undefined} /> : <ChevronRight size={16} style={c ? { color: c } : undefined} />}
            <DIcon size={17} style={c ? { color: c } : undefined} />
            <span className="truncate" style={c ? { color: c } : undefined}>{draggedRow.isRoot ? "Lyra (carpeta)" : displayFolderName(draggedRow.path)}</span>
          </span>
        </div>
        );
      })() : (
        renderFile(draggedRow.path, draggedRow.depth)
      )}
    </div>
  ) : null;

  if (!dndEnabled) {
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

  return (
    <div ref={listRef} onClickCapture={onClickCapture} className="flex flex-col w-[680px] max-w-full pb-20 animate-list-switch" role="list">
      {segments.map(seg => seg.kind === "folder" ? renderFolderRow(seg.row) : renderFileBlock(seg.containerKey, seg.rows))}
      <DragOverlay dnd={dnd}>{cloneContent}</DragOverlay>
    </div>
  );
}
