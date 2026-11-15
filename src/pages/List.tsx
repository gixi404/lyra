import { useEffect, useLayoutEffect, useRef } from "react";
import Form from "../components/Form.tsx";
import ListFiles from "../components/ListFiles.tsx";
import MainContainer from "../components/MainContainer.tsx";
import useFile from "../hooks/useFile.ts";
import { fileStore } from "../store/fileStore.ts";
import { configStore } from "../store/configStore.ts";
import { searchStore } from "../store/searchStore.ts";
import { verifyMainFolder } from "../utils/helpers.ts";
import type { Component } from "../utils/types.ts";
import { useShallow } from "zustand/react/shallow";
import { clearVisibleName, pruneVisibleNameMetadata, removeVisibleNamesForPath } from "../utils/visibleNames.ts";
import { getFolderColors, getFolderIcons, setFolderColor, setFolderIcon } from "../utils/folderAppearance.ts";
import { pruneExplorerKeys } from "../utils/explorerKeys.ts";
import {
  applyListScroll,
  getListContainer,
  getListScroll,
  getMaxScroll,
  getScrollPos,
  setListScroll,
  type ListViewMode,
} from "../utils/listScroll.ts";
import { scrollDebug, snapshotScrollState } from "../utils/scrollDebug.ts";
import { shouldPreserveExplorerDataOnInit, startLocalFirstListInitialization } from "../utils/listInitialization.ts";
import { useScrollSpeed } from "../hooks/useScrollSpeed.ts";
import { logger } from "../utils/logger.ts";
import { invoke } from "@tauri-apps/api/core";
import { recoverPendingLocalMove } from "../utils/pathOperations.ts";
import { notification } from "../utils/helpers.ts";
import { consumeCreatedNoteIntent, getCreatedNoteIntent } from "../utils/createdNoteIntent.ts";

function List(): Component {
  const { getFilesWithStats } = useFile(),
    { setFilesWithStats, setFolders, setFolderListingWarnings, setArchivedFolders, setFolderArchiveError, setFolderArchiveLoaded, fileIsEdited, files, folders, isInitialized } = fileStore(
      useShallow(state => ({
        setFilesWithStats: state.setFilesWithStats,
        setFolders: state.setFolders,
        setFolderListingWarnings: state.setFolderListingWarnings,
        setArchivedFolders: state.setArchivedFolders,
        setFolderArchiveError: state.setFolderArchiveError,
        setFolderArchiveLoaded: state.setFolderArchiveLoaded,
        fileIsEdited: state.fileIsEdited,
        files: state.files,
        folders: state.folders,
        isInitialized: state.isInitialized,
      }))
    ),
    paperIsOpen = configStore(state => state.paperIsOpen),
    search = searchStore(state => state.search),
    isSearching = search.trim().length > 0,
    currentView: ListViewMode = paperIsOpen ? "paper" : "active",
    hasRestoredRef = useRef<boolean>(false),
    prevListingRef = useRef<{
      files: Set<string>;
      folders: Set<string>;
      fileBirth: Record<string, number>;
      everSeenFiles: Set<string>;
      everSeenFolders: Set<string>;
      initialized: boolean;
    }>({
      files: new Set(),
      folders: new Set(),
      fileBirth: {},
      everSeenFiles: new Set(),
      everSeenFolders: new Set(),
      initialized: false,
    });

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Scroll del listado en contenedor propio (independiente del documento/editor).
  useScrollSpeed(containerRef);

  const viewRef = useRef<ListViewMode>(currentView);
  viewRef.current = currentView;

  useEffect(() => {
    scrollDebug("List.mount", { view: viewRef.current, files: files.length, folders: folders.length });
    snapshotScrollState("List.mount", { view: viewRef.current });
    document.documentElement.classList.add("in-list-scroll");
    return () => {
      document.documentElement.classList.remove("in-list-scroll");
      scrollDebug("List.unmount", { view: viewRef.current });
      snapshotScrollState("List.unmount", { view: viewRef.current });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restauración determinista sobre el contenedor propio del listado.
  // Prioriza el posicionamiento de una nota recién creada sobre la restauración previa.
  useLayoutEffect(() => {
    const targetY = getListScroll(currentView);
    const activeIntent = getCreatedNoteIntent();
    scrollDebug("List.restoreEffect.start", {
      currentView, isSearching, filesCount: files.length, foldersCount: folders.length, target: targetY, createdIntent: activeIntent?.fileName,
    });
    snapshotScrollState("List.restoreEffect.start", { currentView, isSearching, target: targetY, createdIntent: activeIntent?.fileName });

    let raf = 0;

    const tryRevealCreatedNote = (): boolean => {
      const intent = getCreatedNoteIntent();
      if (!intent || intent.view !== currentView || isSearching) return false;

      const safeName = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(intent.fileName)
        : intent.fileName.replace(/["\\]/g, "\\$&");
      const el = document.querySelector<HTMLElement>(`[data-note-name="${safeName}"]`);
      const container = getListContainer() ?? containerRef.current;
      if (!el || !container) {
        scrollDebug("List.restore.createdNote.wait", {
          currentView,
          fileName: intent.fileName,
          reason: !container ? "missing-container" : "missing-element",
          isInitialized,
          filesCount: fileStore.getState().files.length,
          hasFileInStore: fileStore.getState().files.includes(intent.fileName),
        });
        snapshotScrollState("List.restore.createdNote.wait", { fileName: intent.fileName, reason: !container ? "missing-container" : "missing-element" });
        return false;
      }

      const isFullyVisible = (): boolean => {
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        return eRect.top >= cRect.top - 0.5 && eRect.bottom <= cRect.bottom + 0.5;
      };

      const beforeScrollTop = container.scrollTop;
      if (!isFullyVisible()) {
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        let next = container.scrollTop;
        if (eRect.height >= cRect.height) {
          // Elemento más alto que el viewport: alinear al inicio para priorizar visibilidad.
          next += eRect.top - cRect.top;
        } else {
          // Posicionar la nota más centrada en el área visible del explorador.
          const desiredTop = cRect.top + (cRect.height - eRect.height) / 2;
          next += eRect.top - desiredTop;
        }
        const applied = applyListScroll(next);
        setListScroll(applied, currentView);
        scrollDebug("List.restore.createdNote.adjust", {
          currentView,
          fileName: intent.fileName,
          beforeScrollTop,
          requested: next,
          applied,
          containerTop: cRect.top,
          containerBottom: cRect.bottom,
          containerHeight: cRect.height,
          elementTop: eRect.top,
          elementBottom: eRect.bottom,
          elementHeight: eRect.height,
        });
      } else {
        setListScroll(container.scrollTop, currentView);
      }

      if (isFullyVisible()) {
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        consumeCreatedNoteIntent(intent.fileName);
        hasRestoredRef.current = true;
        scrollDebug("List.restore.createdNote", {
          currentView,
          fileName: intent.fileName,
          revealed: true,
          consumed: true,
          scrollTop: container.scrollTop,
          containerTop: cRect.top,
          containerBottom: cRect.bottom,
          elementTop: eRect.top,
          elementBottom: eRect.bottom,
        });
        snapshotScrollState("List.restore.createdNote.revealed", { fileName: intent.fileName, scrollTop: container.scrollTop });
        return true;
      }

      // Geometría/animación aún no asentada: mantener intención y reintentar en el siguiente frame.
      hasRestoredRef.current = true;
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      scrollDebug("List.restore.createdNote.pending", {
        currentView,
        fileName: intent.fileName,
        consumed: false,
        scrollTop: container.scrollTop,
        containerTop: cRect.top,
        containerBottom: cRect.bottom,
        elementTop: eRect.top,
        elementBottom: eRect.bottom,
      });
      raf = window.requestAnimationFrame(() => {
        tryRevealCreatedNote();
      });
      return true;
    };

    if (isSearching) {
      applyListScroll(0);
      hasRestoredRef.current = true;
      scrollDebug("List.restoreEffect.searchReset", { currentView });
      return () => { if (raf) window.cancelAnimationFrame(raf); };
    }

    if (tryRevealCreatedNote()) {
      return () => { if (raf) window.cancelAnimationFrame(raf); };
    }

    hasRestoredRef.current = false;
    if (targetY <= 0) {
      hasRestoredRef.current = true;
      return () => { if (raf) window.cancelAnimationFrame(raf); };
    }

    const tryRestore = (): boolean => {
      const maxScroll = getMaxScroll();
      const desired = getListScroll(currentView);
      const clamped = Math.min(desired, maxScroll);
      applyListScroll(clamped);
      const ok = maxScroll >= desired || desired <= 0;
      if (ok) {
        hasRestoredRef.current = true;
        scrollDebug("List.restore.done", { desired, clamped, maxScroll, currentView });
        snapshotScrollState("List.restore.done", { desired, clamped, currentView });
      }
      return ok;
    };

    if (!tryRestore()) {
      // Un frame extra por si el layout del contenedor aún no reflejó la altura final.
      raf = window.requestAnimationFrame(() => {
        if (!tryRestore()) {
          const maxScroll = getMaxScroll();
          const desired = getListScroll(currentView);
          applyListScroll(Math.min(desired, maxScroll));
          hasRestoredRef.current = true;
          scrollDebug("List.restore.settle", { desired, applied: Math.min(desired, maxScroll), maxScroll, currentView });
        }
      });
    }
    return () => { if (raf) window.cancelAnimationFrame(raf); };
  }, [currentView, isSearching, files, folders, isInitialized]);

  // Mantener el scroll del contenedor dentro del rango válido si el contenido cambia,
  // sin perder la intención guardada mientras pueda volver a crecer.
  useEffect(() => {
    if (isSearching || !hasRestoredRef.current) return;
    const maxScroll = getMaxScroll();
    const stored = getListScroll(currentView);
    if (maxScroll <= 0) return;
    const desiredApplied = Math.min(stored, maxScroll);
    const currentDom = containerRef.current?.scrollTop ?? getScrollPos(currentView);
    if (currentDom > maxScroll + 1 || (stored <= maxScroll && Math.abs(currentDom - stored) > 2 && currentDom < stored)) {
      scrollDebug("List.clampAdjust", { stored, maxScroll, desiredApplied, currentDom, currentView });
      applyListScroll(desiredApplied);
    }
  }, [files, folders, currentView, isSearching]);

  // Fuente de verdad: scroll del contenedor propio (no del documento), inmune a transiciones al editor.
  useEffect(() => {
    const el = containerRef.current ?? (typeof document !== "undefined" ? document.getElementById("lyra-list-scroll-container") : null);
    if (!el) return;
    const handleScroll = (): void => {
      if (isSearching) return;
      const pos = el.scrollTop;
      setListScroll(pos, currentView);
      scrollDebug("List.scrollEvent", { view: currentView, pos, source: "container" });
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      const domPos = el.scrollTop;
      const stored = getListScroll(viewRef.current);
      // El contenedor desmontado puede reportar 0; la posición ya se persiste en cada scroll.
      const posToSave = domPos > 0 || stored === 0 ? domPos : stored;
      scrollDebug("List.scrollListener.cleanup", { view: viewRef.current, domPos, stored, posToSave, source: "container" });
      setListScroll(posToSave, viewRef.current);
      snapshotScrollState("List.scrollListener.cleanup", { view: viewRef.current, domPos, stored, posToSave });
    };
  }, [currentView, isSearching, files, folders]);

  useEffect(() => {
    let disposed = false;
    let cleanupInit: (() => void) | undefined;
    void (async () => {
      try {
        await recoverPendingLocalMove();
      } catch (error) {
        if (!disposed) notification("error", `Un movimiento local necesita recuperación: ${String(error)}. Los borradores se conservaron.`);
      }
      if (disposed) return;
      cleanupInit = startLocalFirstListInitialization(
        getFilesWithStats,
        verifyMainFolder,
        ({ files: filesList, stats, folders, warnings }) => {
          const applyGen = fileStore.getState().listingGeneration;
          const currentState = fileStore.getState();
          const hasExistingData = shouldPreserveExplorerDataOnInit(currentState);
          if (!hasExistingData) {
            setFolderArchiveLoaded(false);
          }
          try {
            const prev = prevListingRef.current;
            if (prev.initialized) {
              // "Reaparece" = ausente en el listado previo pero ya visto antes en esta sesión
              // (sustitución/reutilización tras desaparición). La primera aparición (creación/renombrado
              // legítimo iniciado por la app) no debe invalidar metadatos visibles recién confirmados.
              for (const path of filesList) {
                const birth = stats[path]?.birthtime ?? 0;
                const prevBirth = prev.fileBirth[path];
                const missingFromPrev = !prev.files.has(path);
                const reappearedAfterAbsence = missingFromPrev && prev.everSeenFiles.has(path);
                const replaced = prevBirth !== undefined && birth > 0 && prevBirth > 0 && prevBirth !== birth;
                if (reappearedAfterAbsence || replaced) {
                  clearVisibleName(path, "file");
                }
              }
              for (const path of folders) {
                if (!prev.folders.has(path) && prev.everSeenFolders.has(path)) {
                  // Apariencia/nombre visible no verificables sin continuidad inequívoca tras desaparición.
                  try { removeVisibleNamesForPath(path, "folder", false); } catch { /* ignorar */ }
                  try { if (getFolderColors()[path]) setFolderColor(path, undefined); } catch { /* ignorar */ }
                  try { if (getFolderIcons()[path]) setFolderIcon(path, undefined); } catch { /* ignorar */ }
                }
              }
            }
            const nextEverFiles = prev.initialized ? new Set(prev.everSeenFiles) : new Set<string>();
            const nextEverFolders = prev.initialized ? new Set(prev.everSeenFolders) : new Set<string>();
            for (const p of filesList) nextEverFiles.add(p);
            for (const p of folders) nextEverFolders.add(p);
            prevListingRef.current = {
              files: new Set(filesList),
              folders: new Set(folders),
              fileBirth: Object.fromEntries(filesList.map(name => [name, stats[name]?.birthtime ?? 0])),
              everSeenFiles: nextEverFiles,
              everSeenFolders: nextEverFolders,
              initialized: true,
            };
          } catch { /* metadatos corruptos/ausentes no deben bloquear el listado */ }
          try { pruneVisibleNameMetadata(filesList, folders); } catch { /* metadatos corruptos/ausentes no deben bloquear el listado */ }
          try { pruneExplorerKeys(filesList, folders); } catch { /* no bloquear */ }
          setFilesWithStats(filesList, stats);
          setFolders(folders);
          setFolderListingWarnings(warnings ?? []);
          void invoke<string[]>("list_archived_folders").then(archived => {
            if (disposed || fileStore.getState().listingGeneration !== applyGen) return;
            if (hasExistingData) {
              fileStore.getState().setArchivedFolders(archived);
            } else {
              setArchivedFolders(archived);
            }
          }).catch(error => {
            if (disposed || fileStore.getState().listingGeneration !== applyGen) return;
            logger.error("Could not read archived folders", error);
            if (hasExistingData) {
              fileStore.getState().setFolderArchiveError(String(error));
            } else {
              setFolderArchiveError(String(error));
            }
          });
        },
        error => logger.error("Could not initialize note list", error),
        () => fileStore.getState().listingGeneration,
      );
    })();
    return () => {
      disposed = true;
      if (cleanupInit) cleanupInit();
    };
  }, [fileIsEdited, getFilesWithStats, setFilesWithStats, setFolders, setFolderListingWarnings, setArchivedFolders, setFolderArchiveError, setFolderArchiveLoaded]);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      const gen = fileStore.getState().listingGeneration;
      try {
        const listing = await getFilesWithStats();
        if (disposed) return;
        if (fileStore.getState().listingGeneration !== gen) return;
        const current = fileStore.getState();
        const sameNames = JSON.stringify(current.files) === JSON.stringify(listing.files)
          && JSON.stringify(current.folders) === JSON.stringify(listing.folders);
        const sameStats = sameNames && listing.files.every(name =>
          current.statsMap[name]?.mtime === listing.stats[name]?.mtime
          && current.statsMap[name]?.birthtime === listing.stats[name]?.birthtime);
        if (!sameStats) {
          try {
            const prev = prevListingRef.current;
            if (prev.initialized) {
              for (const path of listing.files) {
                const birth = listing.stats[path]?.birthtime ?? 0;
                const prevBirth = prev.fileBirth[path];
                const missingFromPrev = !prev.files.has(path);
                const reappearedAfterAbsence = missingFromPrev && prev.everSeenFiles.has(path);
                const replaced = prevBirth !== undefined && birth > 0 && prevBirth > 0 && prevBirth !== birth;
                if (reappearedAfterAbsence || replaced) clearVisibleName(path, "file");
              }
              for (const path of listing.folders) {
                if (!prev.folders.has(path) && prev.everSeenFolders.has(path)) {
                  try { removeVisibleNamesForPath(path, "folder", false); } catch { /* ignorar */ }
                  try { if (getFolderColors()[path]) setFolderColor(path, undefined); } catch { /* ignorar */ }
                  try { if (getFolderIcons()[path]) setFolderIcon(path, undefined); } catch { /* ignorar */ }
                }
              }
            }
            const nextEverFiles = prev.initialized ? new Set(prev.everSeenFiles) : new Set<string>();
            const nextEverFolders = prev.initialized ? new Set(prev.everSeenFolders) : new Set<string>();
            for (const p of listing.files) nextEverFiles.add(p);
            for (const p of listing.folders) nextEverFolders.add(p);
            prevListingRef.current = {
              files: new Set(listing.files),
              folders: new Set(listing.folders),
              fileBirth: Object.fromEntries(listing.files.map(name => [name, listing.stats[name]?.birthtime ?? 0])),
              everSeenFiles: nextEverFiles,
              everSeenFolders: nextEverFolders,
              initialized: true,
            };
          } catch { /* ignorar */ }
          try { pruneVisibleNameMetadata(listing.files, listing.folders); } catch { /* metadatos corruptos/ausentes no deben bloquear el listado */ }
          try { pruneExplorerKeys(listing.files, listing.folders); } catch { /* no bloquear */ }
          setFilesWithStats(listing.files, listing.stats);
          setFolders(listing.folders);
        } else {
          try {
            const prev = prevListingRef.current;
            if (prev.initialized) {
              for (const path of listing.files) {
                const birth = listing.stats[path]?.birthtime ?? 0;
                const prevBirth = prev.fileBirth[path];
                if (prevBirth !== undefined && birth > 0 && prevBirth > 0 && prevBirth !== birth) {
                  clearVisibleName(path, "file");
                }
              }
            }
            // Mantener conocimiento de rutas vistas incluso sin cambios de stats.
            if (prev.initialized) {
              for (const p of listing.files) prev.everSeenFiles.add(p);
              for (const p of listing.folders) prev.everSeenFolders.add(p);
            }
          } catch { /* ignorar */ }
          try { pruneVisibleNameMetadata(listing.files, listing.folders); } catch { /* ignorar */ }
          try { pruneExplorerKeys(listing.files, listing.folders); } catch { /* no bloquear */ }
        }
        setFolderListingWarnings(listing.warnings ?? []);
        const archived = await invoke<string[]>("list_archived_folders");
        if (disposed || fileStore.getState().listingGeneration !== gen) return;
        if (JSON.stringify(fileStore.getState().archivedFolders) !== JSON.stringify(archived)) setArchivedFolders(archived);
      } catch (error) {
        if (!disposed && fileStore.getState().listingGeneration === gen) {
          logger.warn("Could not refresh external folder changes", error);
        }
      } finally { pending = false; }
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { disposed = true; window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, [getFilesWithStats, setFilesWithStats, setFolders, setFolderListingWarnings, setArchivedFolders]);

  return (
    <MainContainer>
      <div
        id="lyra-list-scroll-container"
        ref={containerRef}
        className="lyra-scroll-container w-full h-dvh overflow-y-auto overflow-x-hidden flex flex-col items-center justify-start pt-14 sm:pt-20 px-4 pb-12"
      >
        <div className="w-[680px] max-w-full flex flex-col items-center gap-y-6 sm:gap-y-8">
          <Form />
          <ListFiles arr={files} />
        </div>
      </div>
    </MainContainer>
  );
}

export default List;
