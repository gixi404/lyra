import { useCallback, useEffect, useRef, useState } from "react";
import type { DragItem, DropTarget } from "./types.ts";
import { computeInsertIndex, detectFileContainer, detectFolderHover, measureFileContainers, measureFolderRows } from "./geometry.ts";

const AUTO_EXPAND_DELAY = 550;
const DRAG_START_THRESHOLD = 5;

export interface ExplorerDndState {
  dragging: DragItem | null;
  pointerId: number;
  pointer: { x: number; y: number } | null;
  cloneOffset: { x: number; y: number };
  cloneSize: { width: number; height: number } | null;
  dropTarget: DropTarget;
  folderHoverPath: string | null;
  finishing: { type: "drop" | "cancel"; toX: number; toY: number } | null;
}

export interface UseExplorerDndOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  scrollRef?: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  manualOrder: boolean;
  canDragFolders: boolean;
  isEffectivelyExpanded: (path: string, isRoot: boolean) => boolean;
  requestTempExpand: (path: string, isRoot: boolean) => void;
  onDrop: (item: DragItem, target: DropTarget, reason: "drop" | "cancel") => Promise<string[] | null> | string[] | null;
  onDragEnd: (keepExpandedPaths: string[] | null, cancelled: boolean) => void;
  onDragActiveChange?: (kind: "file" | "folder" | null, id: string | null) => void;
}

export function parseDragItemId(id: string): DragItem | null {
  if (id.startsWith("file:")) return { kind: "file", id, path: id.slice("file:".length), isRoot: false };
  if (id === "folder:" || id === "folder:root:lyra") return { kind: "folder", id: "folder:", path: "", isRoot: true };
  if (id.startsWith("folder:")) return { kind: "folder", id, path: id.slice("folder:".length), isRoot: false };
  return null;
}

const initialState: ExplorerDndState = {
  dragging: null, pointerId: -1, pointer: null, cloneOffset: { x: 0, y: 0 }, cloneSize: null,
  dropTarget: null, folderHoverPath: null, finishing: null,
};

export function useExplorerDnd(opts: UseExplorerDndOptions) {
  const { rootRef, scrollRef, enabled, manualOrder, canDragFolders, isEffectivelyExpanded, requestTempExpand, onDrop, onDragEnd, onDragActiveChange } = opts;
  const [state, setState] = useState<ExplorerDndState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const pendingRef = useRef<{ pointerId: number; startX: number; startY: number; item: DragItem; el: HTMLElement; captureEl: HTMLElement } | null>(null);
  const autoExpandTimerRef = useRef<number | null>(null);
  const autoExpandTargetRef = useRef<string | null>(null); // path or "" for Lyra, null none
  const rafRef = useRef<number | null>(null);
  const resolvingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const clearAutoExpand = useCallback(() => {
    if (autoExpandTimerRef.current !== null) { window.clearTimeout(autoExpandTimerRef.current); autoExpandTimerRef.current = null; }
    autoExpandTargetRef.current = null;
  }, []);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  const doCleanup = useCallback((keepExpanded: string[] | null, cancelled: boolean) => {
    clearAutoExpand();
    stopRaf();
    const hadDrag = stateRef.current.dragging !== null;
    pendingRef.current = null;
    resolvingRef.current = false;
    lastPointerRef.current = null;
    setState(initialState);
    onDragActiveChange?.(null, null);
    onDragEnd(keepExpanded, cancelled);
    if (hadDrag) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
  }, [clearAutoExpand, onDragActiveChange, onDragEnd, stopRaf]);

  const animateFinish = useCallback((type: "drop" | "cancel", keepExpanded: string[] | null, cancelled: boolean) => {
    const s = stateRef.current;
    if (!s.dragging || !s.pointer) { doCleanup(keepExpanded, cancelled); return; }
    let toX = s.pointer.x - s.cloneOffset.x;
    let toY = s.pointer.y - s.cloneOffset.y;
    if (type === "cancel") {
      // animate back to source element if present
      const src = rootRef.current?.querySelector<HTMLElement>(`[data-explorer-row-id="${CSS.escape(s.dragging.id)}"]`);
      if (src) { const r = src.getBoundingClientRect(); toX = r.left; toY = r.top; }
    }
    setState(prev => prev.dragging ? { ...prev, finishing: { type, toX, toY }, dropTarget: type === "cancel" ? null : prev.dropTarget } : prev);
    window.setTimeout(() => { doCleanup(keepExpanded, cancelled); }, type === "cancel" ? 180 : 140);
  }, [doCleanup, rootRef]);

  const computeTarget = useCallback((clientX: number, clientY: number, item: DragItem): { target: DropTarget; folderHover: string | null } => {
    const root = rootRef.current;
    if (!root) return { target: null, folderHover: null };
    const folderRows = measureFolderRows(root);
    let folderHover = detectFolderHover(clientX, clientY, folderRows, item);
    // Robust fallback: if detector missed, derive folder hover from direct row hit.
    if (folderHover === null) {
      for (const row of folderRows) {
        const r = row.rect;
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
        if (item.kind === "folder" && item.isRoot) continue;
        if (item.kind === "folder" && item.path !== "" && row.path !== "" && (row.path === item.path || row.path.startsWith(`${item.path}/`))) continue;
        folderHover = row.path;
      }
    }
    const containers = measureFileContainers(root, item.id);

    // Ultimate fallback: element-based hit test (guards against measurement edge cases).
    if (folderHover === null) {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const rowEl = el?.closest?.('[data-explorer-row-kind="folder"]') as HTMLElement | null;
      if (rowEl) {
        const path = rowEl.dataset.folderPath ?? (rowEl.dataset.explorerRowId === "folder:" ? "" : (rowEl.dataset.explorerRowId ?? "").slice("folder:".length));
        const isInvalidFolderDrag = item.kind === "folder" && !item.isRoot && path !== "" && (path === item.path || path.startsWith(`${item.path}/`));
        if (!isInvalidFolderDrag && !(item.kind === "folder" && item.isRoot)) folderHover = path;
      }
    }

    if (item.kind === "file") {
      // Direct drop on folder row takes precedence (end of direct notes), even if an empty container is nearby.
      if (folderHover !== null) {
        const overFolderRow = folderRows.some(r => r.path === folderHover && clientX >= r.rect.left && clientX <= r.rect.right && clientY >= r.rect.top && clientY <= r.rect.bottom)
          || (() => { const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null; const re = el?.closest?.('[data-explorer-row-kind="folder"]') as HTMLElement | null; const p = re?.dataset.folderPath ?? (re?.dataset.explorerRowId === "folder:" ? "" : (re?.dataset.explorerRowId ?? "").slice("folder:".length)); return !!re && p === folderHover; })();
        if (overFolderRow) {
          return { target: { type: "file-into-folder", folderPath: folderHover }, folderHover };
        }
      }
      const cont = detectFileContainer(clientX, clientY, containers);
      if (cont) {
        const prev = stateRef.current.dropTarget;
        const prevSameIndex = prev && prev.type === "file-insert" && prev.containerKey === cont.containerKey ? prev.index : null;
        const index = computeInsertIndex(cont, clientY, prevSameIndex);
        return { target: { type: "file-insert", containerKey: cont.containerKey, index }, folderHover };
      }
      if (folderHover !== null) {
        return { target: { type: "file-into-folder", folderPath: folderHover }, folderHover };
      }
      // Final fallback: direct folder-row hit should never resolve to null.
      for (let i = folderRows.length - 1; i >= 0; i--) {
        const row = folderRows[i];
        const rr = row.rect;
        if (clientX < rr.left || clientX > rr.right || clientY < rr.top || clientY > rr.bottom) continue;
        return { target: { type: "file-into-folder", folderPath: row.path }, folderHover: row.path };
      }
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const rowEl = el?.closest?.('[data-explorer-row-kind="folder"]') as HTMLElement | null;
      if (rowEl) {
        const path = rowEl.dataset.folderPath ?? (rowEl.dataset.explorerRowId === "folder:" ? "" : (rowEl.dataset.explorerRowId ?? "").slice("folder:".length));
        return { target: { type: "file-into-folder", folderPath: path }, folderHover: path };
      }
      return { target: null, folderHover: null };
    }

    // folder drag
    if (item.isRoot) return { target: null, folderHover: null };
    if (folderHover !== null) {
      if (folderHover === item.path || (folderHover !== "" && item.path !== "" && folderHover.startsWith(`${item.path}/`))) {
        return { target: null, folderHover: null };
      }
      // if hovering a sibling folder (same parent) => reorder among siblings; else move into that folder
      const draggedParent = item.path.includes("/") ? item.path.split("/").slice(0, -1).join("/") : "";
      const hoverRow = folderRows.find(r => r.path === folderHover);
      if (hoverRow && !hoverRow.isRoot) {
        const hoverParent = folderHover.includes("/") ? folderHover.split("/").slice(0, -1).join("/") : "";
        if (hoverParent === draggedParent) {
          // sibling reorder: compute index among sibling folders (same parent) excluding dragged
          const siblings = folderRows.filter(r => !r.isRoot && (r.path.includes("/") ? r.path.split("/").slice(0, -1).join("/") : "") === draggedParent && r.id !== item.id);
          // index relative to hovered sibling position
          let idx = siblings.findIndex(r => r.path === folderHover);
          if (idx === -1) idx = siblings.length;
          else if (clientY >= hoverRow.midY) idx = idx + 1;
          const refPath = siblings[idx]?.path;
          return { target: { type: "folder-reorder", parentKey: draggedParent === "" ? "$top" : draggedParent, index: idx, refPath }, folderHover };
        }
      }
      return { target: { type: "folder-into", targetFolderPath: folderHover }, folderHover };
    }
    return { target: null, folderHover: null };
  }, [rootRef]);

  const scheduleAutoExpand = useCallback((folderHover: string | null, item: DragItem) => {
    if (folderHover === null) { if (autoExpandTargetRef.current !== null) clearAutoExpand(); return; }
    const isRoot = folderHover === "";
    if (item.kind === "folder" && item.path !== "" && folderHover !== "" && (folderHover === item.path || folderHover.startsWith(`${item.path}/`))) {
      clearAutoExpand(); return;
    }
    const needs = !isEffectivelyExpanded(folderHover, isRoot);
    if (!needs) { if (autoExpandTargetRef.current !== null) clearAutoExpand(); return; }
    if (autoExpandTargetRef.current === folderHover) return; // same target: do not reset timer
    clearAutoExpand();
    autoExpandTargetRef.current = folderHover;
    autoExpandTimerRef.current = window.setTimeout(() => {
      const target = autoExpandTargetRef.current;
      autoExpandTargetRef.current = null;
      autoExpandTimerRef.current = null;
      if (target === null) return;
      const rootT = target === "";
      if (isEffectivelyExpanded(target, rootT)) return;
      const cur = stateRef.current.dragging;
      if (cur?.kind === "folder" && cur.path !== "" && target !== "" && (target === cur.path || target.startsWith(`${cur.path}/`))) return;
      requestTempExpand(target, rootT);
    }, AUTO_EXPAND_DELAY);
  }, [clearAutoExpand, isEffectivelyExpanded, requestTempExpand]);

  const updateFrame = useCallback(() => {
    rafRef.current = null;
    const s = stateRef.current;
    if (!s.dragging || !s.pointer) return;
    const { target, folderHover } = computeTarget(s.pointer.x, s.pointer.y, s.dragging);
    scheduleAutoExpand(folderHover, s.dragging);

    setState(prev => {
      if (!prev.dragging) return prev;
      const sameTarget = JSON.stringify(prev.dropTarget) === JSON.stringify(target);
      if (sameTarget && prev.folderHoverPath === folderHover) return prev;
      return { ...prev, dropTarget: target, folderHoverPath: folderHover };
    });

    // autoscroll
    const scroller = scrollRef?.current ?? rootRef.current?.closest("[data-explorer-scroll]") as HTMLElement | null ?? rootRef.current?.parentElement ?? null;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const edge = 56;
      const maxSpeed = 20;
      const y = s.pointer.y;
      let dy = 0;
      if (y < r.top + edge) dy = -Math.ceil(maxSpeed * Math.max(0, 1 - (y - r.top) / edge));
      else if (y > r.bottom - edge) dy = Math.ceil(maxSpeed * Math.max(0, 1 - (r.bottom - y) / edge));
      if (dy !== 0) scroller.scrollTop += dy;
    }

    if (stateRef.current.dragging) {
      rafRef.current = window.requestAnimationFrame(updateFrame);
    }
  }, [computeTarget, rootRef, scheduleAutoExpand, scrollRef]);

  const ensureRaf = useCallback(() => {
    if (rafRef.current === null) rafRef.current = window.requestAnimationFrame(updateFrame);
  }, [updateFrame]);

  const finishDrag = useCallback(async (reason: "drop" | "cancel") => {
    const s = stateRef.current;
    if (!s.dragging) { doCleanup(null, true); return; }
    resolvingRef.current = true;
    clearAutoExpand();
    stopRaf();
    const item = s.dragging;
    const target = reason === "cancel" ? null : s.dropTarget;
    try {
      const keep = await onDrop(item, target, reason);
      const cancelled = reason === "cancel" || keep == null;
      animateFinish(cancelled ? "cancel" : "drop", cancelled ? null : keep, cancelled);
    } catch {
      animateFinish("cancel", null, true);
    }
  }, [animateFinish, clearAutoExpand, doCleanup, onDrop, stopRaf]);

  useEffect(() => {
    if (!state.dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stateRef.current.dragging) {
        e.preventDefault();
        e.stopPropagation();
        void finishDrag("cancel");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finishDrag, state.dragging]);

  useEffect(() => {
    if (!enabled) return;
    const onMove = (e: PointerEvent) => {
      const pending = pendingRef.current;
      const s = stateRef.current;
      if (pending && !s.dragging) {
        if (e.pointerId !== pending.pointerId) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (dx * dx + dy * dy < DRAG_START_THRESHOLD * DRAG_START_THRESHOLD) return;
        const rect = pending.el.getBoundingClientRect();
        const item = pending.item;
        const pointerId = pending.pointerId;
        // Capture on a persistent element (the original row may be unmounted on drag start).
        const captureTarget = (rootRef.current ?? document.documentElement) as HTMLElement;
        pendingRef.current = null;
        try {
          captureTarget.setPointerCapture(pointerId);
        } catch {
          // ignore capture failure
        }
        lastPointerRef.current = { x: e.clientX, y: e.clientY };
        const next: ExplorerDndState = {
          dragging: item,
          pointerId,
          pointer: { x: e.clientX, y: e.clientY },
          cloneOffset: { x: e.clientX - rect.left, y: e.clientY - rect.top },
          cloneSize: { width: rect.width, height: rect.height },
          dropTarget: null,
          folderHoverPath: null,
          finishing: null,
        };
        stateRef.current = next;
        setState(next);
        onDragActiveChange?.(item.kind, item.id);
        ensureRaf();
        return;
      }
      if (!s.dragging || e.pointerId !== s.pointerId) return;
      if (resolvingRef.current) return;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      stateRef.current = { ...s, pointer: { x: e.clientX, y: e.clientY } };
      setState(prev => prev.dragging && prev.pointerId === e.pointerId ? { ...prev, pointer: { x: e.clientX, y: e.clientY } } : prev);
      ensureRaf();
    };
    const onUp = (e: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && e.pointerId === pending.pointerId && !stateRef.current.dragging) {
        pendingRef.current = null;
        return;
      }
      if (stateRef.current.dragging && e.pointerId === stateRef.current.pointerId) {
        e.preventDefault();
        void finishDrag("drop");
      }
    };
    const onCancel = (e: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && e.pointerId === pending.pointerId) pendingRef.current = null;
      if (stateRef.current.dragging && e.pointerId === stateRef.current.pointerId) void finishDrag("cancel");
    };
    const onLost = (e: PointerEvent) => {
      // pointerup may trigger lostpointercapture; avoid cancelling a drop being resolved
      if (resolvingRef.current) return;
      if (stateRef.current.dragging && e.pointerId === stateRef.current.pointerId) void finishDrag("cancel");
    };
    const onBlur = () => {
      if (!resolvingRef.current && stateRef.current.dragging) void finishDrag("cancel");
    };
    const onVisibility = () => {
      if (document.hidden && !resolvingRef.current && stateRef.current.dragging) void finishDrag("cancel");
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("lostpointercapture", onLost, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("lostpointercapture", onLost, true);
    };
  }, [enabled, ensureRaf, finishDrag, onDragActiveChange, rootRef]);

  useEffect(() => () => { clearAutoExpand(); stopRaf(); }, [clearAutoExpand, stopRaf]);

  useEffect(() => {
    if (!enabled && (stateRef.current.dragging || pendingRef.current)) {
      clearAutoExpand();
      stopRaf();
      pendingRef.current = null;
      resolvingRef.current = false;
      lastPointerRef.current = null;
      stateRef.current = initialState;
      setState(initialState);
    }
  }, [enabled, clearAutoExpand, stopRaf]);

  const onPointerDownRow = useCallback((e: React.PointerEvent, rowId: string) => {
    if (!enabled) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (stateRef.current.dragging || resolvingRef.current) return;
    const item = parseDragItemId(rowId);
    if (!item) return;
    if (item.kind === "file" && !manualOrder) return;
    if (item.kind === "folder" && (!canDragFolders || item.isRoot)) return;
    const targetEl = e.target as HTMLElement | null;
    if (targetEl && targetEl.closest("button, a, input, textarea, select, [data-no-dnd], [role='menuitem']")) return;
    const el = (e.currentTarget as HTMLElement);
    pendingRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, item, el, captureEl: el };
  }, [canDragFolders, enabled, manualOrder]);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClickRef.current = false;
    }
  }, []);

  // recompute on scroll/resize while dragging
  useEffect(() => {
    if (!state.dragging) return;
    const onScrollOrResize = () => ensureRaf();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    const root = rootRef.current;
    const ro = typeof ResizeObserver !== "undefined" && root ? new ResizeObserver(() => ensureRaf()) : null;
    if (ro && root) ro.observe(root);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      ro?.disconnect();
    };
  }, [ensureRaf, rootRef, state.dragging]);

  return { dnd: state, onPointerDownRow, onClickCapture };
}
