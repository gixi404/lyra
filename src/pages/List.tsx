import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import Form from "../components/Form";
import ListFiles from "../components/ListFiles";
import MainContainer from "../components/MainContainer";
import useFile from "../hooks/useFile";
import { fileStore } from "../store/fileStore";
import { configStore } from "../store/configStore.ts";
import { searchStore } from "../store/searchStore.ts";
import { verifyMainFolder } from "../utils/helpers";
import type { Component } from "../utils/types";
import { useShallow } from "zustand/react/shallow";
import {
  getListScroll,
  setListScroll,
  type ListViewMode,
} from "../utils/listScroll.ts";
import { startLocalFirstListInitialization } from "../utils/listInitialization";
import useScrollSpeed from "../hooks/useScrollSpeed";

function List(): Component {
  const { getFilesWithStats } = useFile(),
    { setFilesWithStats, fileIsEdited, files } = fileStore(
      useShallow(state => ({
        setFilesWithStats: state.setFilesWithStats,
        fileIsEdited: state.fileIsEdited,
        files: state.files,
      }))
    ),
    paperIsOpen = configStore(state => state.paperIsOpen),
    search = searchStore(state => state.search),
    isSearching = search.trim().length > 0,
    currentView: ListViewMode = paperIsOpen ? "paper" : "active",
    containerRef = useRef<HTMLDivElement>(null),
    hasRestoredRef = useRef<boolean>(false);

  useScrollSpeed(containerRef);

  // Restauración determinista del scroll al montar o al alternar entre notas activas y archivadas
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (isSearching) {
      container.scrollTop = 0;
      return;
    }

    const targetY = getListScroll(currentView);
    if (targetY <= 0) {
      container.scrollTop = 0;
      hasRestoredRef.current = true;
      return;
    }

    // Si el contenedor ya tiene altura suficiente, restaurar inmediatamente antes de pintar
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScroll > 0) {
      container.scrollTop = Math.min(targetY, maxScroll);
      hasRestoredRef.current = true;
    } else {
      hasRestoredRef.current = false;
    }
  }, [currentView, isSearching]);

  // Si los archivos se cargaron tras el montaje inicial, restaurar una vez disponible la altura
  useLayoutEffect(() => {
    if (isSearching || hasRestoredRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    const targetY = getListScroll(currentView);
    if (targetY <= 0) {
      hasRestoredRef.current = true;
      return;
    }

    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScroll > 0) {
      container.scrollTop = Math.min(targetY, maxScroll);
      hasRestoredRef.current = true;
    }
  }, [files, currentView, isSearching]);

  // Si se eliminan o archivan elementos y la altura total disminuye, ajustar al nuevo máximo disponible
  useEffect(() => {
    if (isSearching) return;
    const container = containerRef.current;
    if (!container) return;

    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScroll <= 0) return;

    const currentY = container.scrollTop;
    if (currentY > maxScroll) {
      container.scrollTop = maxScroll;
      setListScroll(maxScroll, currentView);
    }
  }, [files, currentView, isSearching]);

  // Única fuente de verdad: registrar el scroll conforme el usuario se desplaza
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>): void => {
      if (isSearching) return;
      const y = e.currentTarget.scrollTop;
      setListScroll(y, currentView);
    },
    [currentView, isSearching]
  );

  useEffect(() => {
    return startLocalFirstListInitialization(
      getFilesWithStats,
      verifyMainFolder,
      ({ files: filesList, stats }) => setFilesWithStats(filesList, stats),
      error => console.error("Could not initialize note list", error),
    );
  }, [fileIsEdited, getFilesWithStats, setFilesWithStats]);

  return (
    <MainContainer>
      <div
        ref={containerRef}
        id="lyra-list-scroll-container"
        onScroll={handleScroll}
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
