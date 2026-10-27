import ItemFile from "./ItemFile";
import Modal from "./Modal";
import NoFiles from "./NoFiles";
import NoMatches from "./NoMatches";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { configStore } from "../store/configStore";
import { len, normalize, notification, themes } from "../utils/helpers";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { searchStore, type SortOptionId } from "../store/searchStore";
import { fileStore } from "../store/fileStore";
import type { Component } from "../utils/types";
import { resetListScroll } from "../utils/listScroll";

const SESSION_RANDOM_SALT = Math.floor(Math.random() * 0x7fffffff) + 1;

const getHash = (str: string): number => {
  let hash = SESSION_RANDOM_SALT;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
};

const ListFiles = memo(({ arr }: Props): Component => {
  const { myPaper } = usePreferences(),
    { isDay } = themes(),
    { search, resetSearch, sortOption } = searchStore(
      useShallow(state => ({
        search: state.search,
        resetSearch: state.resetSearch,
        sortOption: (state.sortOption || state.sortOptions?.[0] || "mtime") as SortOptionId,
      }))
    ),
    { statsMap, isInitialized } = fileStore(
      useShallow(state => ({
        statsMap: state.statsMap,
        isInitialized: state.isInitialized,
      }))
    ),
    paperIsOpen = configStore(state => state.paperIsOpen),
    fileIsEdited = fileStore(state => state.fileIsEdited),
    normalizedSearch = useMemo(() => normalize(search), [search]),
    paperFiles = useMemo(() => myPaper(arr), [arr, fileIsEdited]),
    paperSet = useMemo(() => new Set(paperFiles), [paperFiles]),
    [isEmptyModalOpen, setIsEmptyModalOpen] = useState<boolean>(false),
    { deleteFile } = useFile(),
    { setItem } = useStorage(),
    removeFileFromList = fileStore(state => state.removeFileFromList),
    editedFile = fileStore(state => state.editedFile);

  async function handleEmptyArchivedConfirm(): Promise<void> {
    setIsEmptyModalOpen(false);
    try {
      for (const fileName of paperFiles) {
        await deleteFile(fileName);
        removeFileFromList(fileName);
      }
      setItem("paper", JSON.stringify([]));
      editedFile();
      notification("success", "Archivados eliminados permanentemente");
    } catch {
      notification("error", "Error al vaciar los archivos archivados");
    }
  }

  const isReady = isInitialized;

  const files = useMemo(() => {
    const source = paperIsOpen ? paperFiles : arr.filter(f => !paperSet.has(f));

    const indexedSource = source.map(name => ({
      name,
      normalizedName: normalize(name),
    }));

    const filtered = source.filter((_, index) =>
      indexedSource[index].normalizedName.includes(normalizedSearch)
    );

    return filtered.sort((a, b) => {
      let res = 0;
      if (sortOption === "mtime") {
        res = (statsMap[b]?.mtime || 0) - (statsMap[a]?.mtime || 0);
      } else if (sortOption === "az") {
        res = a.localeCompare(b);
      } else if (sortOption === "za") {
        res = b.localeCompare(a);
      } else if (sortOption === "recent") {
        res = (statsMap[b]?.birthtime || 0) - (statsMap[a]?.birthtime || 0);
      } else if (sortOption === "oldest") {
        res = (statsMap[a]?.birthtime || 0) - (statsMap[b]?.birthtime || 0);
      } else if (sortOption === "random") {
        res = getHash(a) - getHash(b);
      }
      if (res !== 0) return res;
      return a.localeCompare(b);
    });
  }, [arr, normalizedSearch, sortOption, paperFiles, paperIsOpen, paperSet, statsMap]);

  const isFirstMountRef = useRef<boolean>(true);
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }
    resetSearch();
    resetListScroll();
    window.scrollTo(0, 0);
  }, [paperIsOpen]);

  function renderFiles(): Component {
    if (len(files) === 0) {
      if (len(normalizedSearch) > 0) return <NoMatches />;
      return <NoFiles />;
    }

    return (
      <>
        {files.map((n: string) => (
          <ItemFile fileName={n} key={n} />
        ))}
      </>
    );
  }

  return (
    <div className={`flex flex-col w-[680px] max-w-full transition-opacity duration-150 ${isReady ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
      {/* Cabecera DOCUMENTOS + Contador */}
      <div
        className={`flex items-center justify-between w-[680px] max-w-full px-1 pb-2.5 mb-1 border-b ${
          isDay ? "border-neutral-200 text-neutral-400" : "border-zinc-800/80 text-zinc-500"
        }`}
      >
        <span
          key={`title-${paperIsOpen}`}
          className="font-mono text-[11px] tracking-widest uppercase animate-list-header"
        >
          {paperIsOpen ? "ARCHIVADOS" : "DOCUMENTOS"}
        </span>
        <div className="flex items-center gap-x-3">
          {paperIsOpen && files.length > 0 && (
            <button
              type="button"
              onClick={() => setIsEmptyModalOpen(true)}
              className="text-[11px] font-mono tracking-wider text-rose-500/80 hover:text-rose-500 transition-all duration-150 cursor-pointer active:scale-95"
              title="Vaciar todos los archivos archivados"
            >
              Vaciar
            </button>
          )}
          <span
            key={`count-${paperIsOpen}`}
            className="font-mono text-[11px] tracking-widest pr-1.5 animate-list-header"
          >
            {files.length}
          </span>
        </div>
      </div>

      <ul
        key={paperIsOpen ? "paper" : "active"}
        className="flex flex-col w-[680px] max-w-full pb-20 animate-list-switch"
      >
        {renderFiles()}
      </ul>

      <Modal
        isOpen={isEmptyModalOpen}
        onClose={() => setIsEmptyModalOpen(false)}
        onConfirm={handleEmptyArchivedConfirm}
        title="¿Vaciar todos los archivados?"
        description="Esta acción eliminará de forma permanente todos los archivos archivados. No se podrá deshacer."
        confirmText="Vaciar todo"
        cancelText="Cancelar"
        variant="danger"
      />
    </div>
  );
});

export default ListFiles;

interface Props {
  arr: string[];
}
