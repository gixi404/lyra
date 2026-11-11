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
import {
  applyListScroll,
  getListScroll,
  getMaxScroll,
  getScrollPos,
  setListScroll,
  type ListViewMode,
} from "../utils/listScroll.ts";
import { shouldPreserveExplorerDataOnInit, startLocalFirstListInitialization } from "../utils/listInitialization.ts";
import useScrollSpeed from "../hooks/useScrollSpeed.ts";
import { logger } from "../utils/logger.ts";
import { invoke } from "@tauri-apps/api/core";
import { recoverPendingLocalMove } from "../utils/pathOperations.ts";
import { notification } from "../utils/helpers.ts";

function List(): Component {
  const { getFilesWithStats } = useFile(),
    { setFilesWithStats, setFolders, setFolderListingWarnings, setArchivedFolders, setFolderArchiveError, setFolderArchiveLoaded, fileIsEdited, files } = fileStore(
      useShallow(state => ({
        setFilesWithStats: state.setFilesWithStats,
        setFolders: state.setFolders,
        setFolderListingWarnings: state.setFolderListingWarnings,
        setArchivedFolders: state.setArchivedFolders,
        setFolderArchiveError: state.setFolderArchiveError,
        setFolderArchiveLoaded: state.setFolderArchiveLoaded,
        fileIsEdited: state.fileIsEdited,
        files: state.files,
      }))
    ),
    paperIsOpen = configStore(state => state.paperIsOpen),
    search = searchStore(state => state.search),
    isSearching = search.trim().length > 0,
    currentView: ListViewMode = paperIsOpen ? "paper" : "active",
    hasRestoredRef = useRef<boolean>(false);

  // El scroll real del listado es el de la ventana (html overflow-y: scroll),
  // igual que en Preferencias: se aplica la velocidad sobre window.
  useScrollSpeed();

  // Restauración determinista del scroll al montar o al alternar entre notas activas y archivadas
  useLayoutEffect(() => {
    if (isSearching) {
      applyListScroll(0);
      return;
    }

    const targetY = getListScroll(currentView);
    if (targetY <= 0) {
      applyListScroll(0);
      hasRestoredRef.current = true;
      return;
    }

    // Si la página ya tiene altura suficiente, restaurar inmediatamente antes de pintar
    const maxScroll = getMaxScroll();
    if (maxScroll > 0) {
      applyListScroll(Math.min(targetY, maxScroll));
      hasRestoredRef.current = true;
    } else {
      hasRestoredRef.current = false;
    }
  }, [currentView, isSearching]);

  // Si los archivos se cargaron tras el montaje inicial, restaurar una vez disponible la altura
  useLayoutEffect(() => {
    if (isSearching || hasRestoredRef.current) return;

    const targetY = getListScroll(currentView);
    if (targetY <= 0) {
      hasRestoredRef.current = true;
      return;
    }

    const maxScroll = getMaxScroll();
    if (maxScroll > 0) {
      applyListScroll(Math.min(targetY, maxScroll));
      hasRestoredRef.current = true;
    }
  }, [files, currentView, isSearching]);

  // Si se eliminan o archivan elementos y la altura total disminuye, ajustar al nuevo máximo disponible
  useEffect(() => {
    if (isSearching) return;

    const maxScroll = getMaxScroll();
    if (maxScroll <= 0) return;

    const currentY = getScrollPos(currentView);
    if (currentY > maxScroll) {
      applyListScroll(maxScroll);
      setListScroll(maxScroll, currentView);
    }
  }, [files, currentView, isSearching]);

  // Única fuente de verdad: registrar el scroll de la ventana conforme el usuario se desplaza
  useEffect(() => {
    const handleWindowScroll = (): void => {
      if (isSearching) return;
      setListScroll(getScrollPos(currentView), currentView);
    };
    window.addEventListener("scroll", handleWindowScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleWindowScroll);
  }, [currentView, isSearching]);

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
          const currentState = fileStore.getState();
          const hasExistingData = shouldPreserveExplorerDataOnInit(currentState);
          if (!hasExistingData) {
            setFolderArchiveLoaded(false);
          }
          setFilesWithStats(filesList, stats);
          setFolders(folders);
          setFolderListingWarnings(warnings ?? []);
          void invoke<string[]>("list_archived_folders").then(archived => {
            if (hasExistingData) {
              fileStore.getState().setArchivedFolders(archived);
            } else {
              setArchivedFolders(archived);
            }
          }).catch(error => {
            logger.error("Could not read archived folders", error);
            if (hasExistingData) {
              fileStore.getState().setFolderArchiveError(String(error));
            } else {
              setFolderArchiveError(String(error));
            }
          });
        },
        error => logger.error("Could not initialize note list", error),
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
      try {
        const listing = await getFilesWithStats();
        if (disposed) return;
        const current = fileStore.getState();
        const sameNames = JSON.stringify(current.files) === JSON.stringify(listing.files)
          && JSON.stringify(current.folders) === JSON.stringify(listing.folders);
        const sameStats = sameNames && listing.files.every(name =>
          current.statsMap[name]?.mtime === listing.stats[name]?.mtime
          && current.statsMap[name]?.birthtime === listing.stats[name]?.birthtime);
        if (!sameStats) { setFilesWithStats(listing.files, listing.stats); setFolders(listing.folders); }
        setFolderListingWarnings(listing.warnings ?? []);
        const archived = await invoke<string[]>("list_archived_folders");
        if (!disposed && JSON.stringify(fileStore.getState().archivedFolders) !== JSON.stringify(archived)) setArchivedFolders(archived);
      } catch (error) {
        if (!disposed) logger.warn("Could not refresh external folder changes", error);
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
        className="lyra-scroll-container w-full h-full flex flex-col items-center justify-start pt-14 sm:pt-20 px-4 pb-12"
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
