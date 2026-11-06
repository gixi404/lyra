import { useEffect, useLayoutEffect, useRef } from "react";
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
  applyListScroll,
  getListScroll,
  getMaxScroll,
  getScrollPos,
  setListScroll,
  type ListViewMode,
} from "../utils/listScroll.ts";
import { startLocalFirstListInitialization } from "../utils/listInitialization";
import useScrollSpeed from "../hooks/useScrollSpeed";
import { logger } from "../utils/logger.ts";

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
    return startLocalFirstListInitialization(
      getFilesWithStats,
      verifyMainFolder,
      ({ files: filesList, stats }) => setFilesWithStats(filesList, stats),
      error => logger.error("Could not initialize note list", error),
    );
  }, [fileIsEdited, getFilesWithStats, setFilesWithStats]);

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
