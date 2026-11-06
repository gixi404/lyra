import ItemFile from "./ItemFile";
import Modal from "./Modal";
import NoFiles from "./NoFiles";
import NoMatches from "./NoMatches";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import { configStore } from "../store/configStore";
import { len, normalize, notification, themes } from "../utils/helpers";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { searchStore, type SortOptionId } from "../store/searchStore";
import { fileStore } from "../store/fileStore";
import type { Component } from "../utils/types";
import { AlertCircle } from "lucide-react";
import { includeRetainedExits } from "../utils/listExit";
import { deleteArchivedBatch } from "../utils/archiveDeletion";
import { noteLabel, noteSuccessMessage, noteTitle } from "../utils/noteName";

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
    { statsMap, isInitialized, retainedExits } = fileStore(
      useShallow(state => ({
        statsMap: state.statsMap,
        isInitialized: state.isInitialized,
        retainedExits: state.retainedExits,
      }))
    ),
    paperIsOpen = configStore(state => state.paperIsOpen),
    fileIsEdited = fileStore(state => state.fileIsEdited),
    normalizedSearch = useMemo(() => normalize(search), [search]),
    paperFiles = useMemo(() => {
      void fileIsEdited;
      void paperIsOpen;
      return myPaper(arr);
    }, [arr, fileIsEdited, paperIsOpen, myPaper]),
    paperSet = useMemo(() => new Set(paperFiles), [paperFiles]),
    [isEmptyModalOpen, setIsEmptyModalOpen] = useState<boolean>(false),
    isDeleting = fileStore(state => state.isEmptyingArchived),
    hasIndividualDeletion = fileStore(state => state.deletingFiles.length > 0),
    deletionBusy = isDeleting || hasIndividualDeletion,
    mountedRef = useRef(false),
    [showTooltip, setShowTooltip] = useState<boolean>(false),
    { deleteFile } = useFile(),
    exitingFiles = fileStore(state => state.exitingFiles),
    removeFileFromList = fileStore(state => state.removeFileFromList),
    editedFile = fileStore(state => state.editedFile);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fileStore.getState().flushPendingExits();
    };
  }, []);

  async function handleEmptyArchivedConfirm(): Promise<void> {
    if (fileStore.getState().isEmptyingArchived || fileStore.getState().deletingFiles.length > 0) return;
    const toDelete = [...paperFiles];
    if (toDelete.length === 0) return;

    fileStore.getState().setEmptyingArchived(true);
    try {
      const { deleted, failed } = await deleteArchivedBatch(
        toDelete,
        deleteFile,
        name => fileStore.getState().retainForExit(name, "paper"),
        name => fileStore.getState().releaseRetainedExit(name),
      );
      for (const { name, error } of failed) {
        console.error(`Error al eliminar ${name}:`, error);
      }

      if (deleted.length > 0) {
        if (failed.length > 0) {
          notification("error", `Se eliminaron ${deleted.length} de ${toDelete.length} notas archivadas`);
        } else {
          notification("success", toDelete.length === 1
            ? noteSuccessMessage(toDelete[0], "deleted")
            : "Archivos eliminados permanentemente");
        }
        fileStore.getState().scheduleExitAnimation(deleted, () => {
          for (const fileName of deleted) {
            removeFileFromList(fileName);
          }
          editedFile();
        });
      } else if (failed.length > 0) {
        notification("error", toDelete.length === 1
          ? `No se pudo eliminar ${noteLabel(toDelete[0])}`
          : "No se pudo eliminar ninguna nota archivada");
      }
    } finally {
      fileStore.getState().setEmptyingArchived(false);
      if (mountedRef.current) {
        setIsEmptyModalOpen(false);
      }
    }
  }

  const isReady = isInitialized;

  const files = useMemo(() => {
    const current = paperIsOpen ? paperFiles : arr.filter(f => !paperSet.has(f));

    const indexedSource = current.map(name => ({
      name,
      normalizedName: normalize(name),
    }));

    const filtered = current.filter((_, index) =>
      indexedSource[index].normalizedName.includes(normalizedSearch)
    );

    const sorted = filtered.sort((a, b) => {
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
    const matchingRetained = retainedExits.filter(item => normalize(item.name).includes(normalizedSearch));
    return includeRetainedExits(sorted, matchingRetained, paperIsOpen ? "paper" : "active");
  }, [arr, normalizedSearch, sortOption, paperFiles, paperIsOpen, paperSet, statsMap, retainedExits]);

  useEffect(() => {
    fileStore.getState().setRenderedOrder(paperIsOpen ? "paper" : "active", files);
  }, [paperIsOpen, files]);

  const isFirstMountRef = useRef<boolean>(true);
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }
    resetSearch();
    setShowTooltip(false);
    fileStore.getState().flushPendingExits();
  }, [paperIsOpen, resetSearch]);

  const homonymSet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of arr) {
      const title = noteTitle(f).toLowerCase();
      counts.set(title, (counts.get(title) || 0) + 1);
    }
    const homonyms = new Set<string>();
    for (const [title, count] of counts.entries()) {
      if (count > 1) {
        homonyms.add(title);
      }
    }
    return homonyms;
  }, [arr]);

  function renderFiles(): Component {
    if (len(files) === 0) {
      if (len(normalizedSearch) > 0) return <NoMatches />;
      return <NoFiles />;
    }

    return (
      <>
        {files.map((n: string) => (
          <ItemFile
            fileName={n}
            key={n}
            isExiting={exitingFiles.includes(n)}
            isHomonym={homonymSet.has(noteTitle(n).toLowerCase())}
          />
        ))}
      </>
    );
  }

  const visibleFilesCount = useMemo(() => {
    if (exitingFiles.length === 0) return files.length;
    return files.filter(f => !exitingFiles.includes(f)).length;
  }, [files, exitingFiles]);

  return (
    <div className={`flex flex-col w-[680px] max-w-full transition-opacity duration-150 ${isReady ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
      {/* Cabecera DOCUMENTOS + Contador */}
      <div
        className={`flex items-center justify-between w-[680px] max-w-full px-1 pb-2.5 mb-1 border-b ${
          isDay ? "border-neutral-200 text-neutral-500/85" : "border-zinc-800/80 text-zinc-400/85"
        }`}
      >
        <div className="flex items-center gap-x-1.5">
          <span
            key={`title-${paperIsOpen}`}
            className="font-mono text-[11px] font-semibold tracking-widest uppercase animate-list-header"
          >
            {paperIsOpen ? "ARCHIVADOS" : "DOCUMENTOS"}
          </span>
          {paperIsOpen && (
            <div className="relative inline-flex items-center">
              <button
                type="button"
                onMouseEnter={() => setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
                onFocus={() => setShowTooltip(true)}
                onBlur={() => setShowTooltip(false)}
                onKeyDown={e => {
                  if (e.key === "Escape") setShowTooltip(false);
                }}
                className={`p-1 -my-1 rounded-full transition-colors duration-150 cursor-help outline-none focus-visible:ring-1 ${
                  isDay
                    ? "text-neutral-400 hover:text-neutral-600 focus-visible:text-neutral-700 focus-visible:ring-neutral-400"
                    : "text-zinc-500 hover:text-zinc-300 focus-visible:text-zinc-200 focus-visible:ring-zinc-600"
                }`}
                aria-label="Información sobre la papelera de Google Drive para archivos archivados"
                aria-describedby="archived-gdrive-tooltip"
              >
                <AlertCircle className="w-3.5 h-3.5" />
              </button>
              {showTooltip && (
                <div
                  id="archived-gdrive-tooltip"
                  role="tooltip"
                  style={{
                    backgroundColor: isDay ? "#ffffff" : "#18181b",
                  }}
                  className={`absolute left-0 top-full mt-2 w-72 p-2.5 rounded-xl border text-[11px] leading-relaxed shadow-xl pointer-events-none z-50 animate-in fade-in zoom-in-95 duration-150 font-sans normal-case tracking-normal font-normal select-none ${
                    isDay
                      ? "border-neutral-200 text-neutral-600 shadow-neutral-300/40"
                      : "border-zinc-700 text-zinc-300 shadow-2xl shadow-black/80"
                  }`}
                >
                  Los archivos eliminados de Archivados pueden recuperarse durante un máximo de 30 días desde la papelera de Google Drive, siempre y cuando hayas conectado previamente tu cuenta.
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-x-3">
          {paperIsOpen && visibleFilesCount > 0 && (
            <button
              type="button"
              onClick={() => setIsEmptyModalOpen(true)}
              disabled={deletionBusy}
              className={`text-[11px] font-mono font-semibold tracking-wider transition-all duration-150 select-none ${
                deletionBusy
                  ? "text-rose-500/40 opacity-40 cursor-not-allowed"
                  : "text-rose-500/90 enabled:hover:text-rose-500 cursor-pointer active:scale-95"
              } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-rose-500/40 disabled:active:scale-100`}
              title="Vaciar todos los archivos archivados"
            >
              Vaciar
            </button>
          )}
          <span
            key={`count-${paperIsOpen}`}
            className="font-mono text-[11px] font-semibold tracking-widest pr-1.5 animate-list-header"
          >
            {visibleFilesCount}
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
        onClose={() => { if (!deletionBusy) setIsEmptyModalOpen(false); }}
        onConfirm={handleEmptyArchivedConfirm}
        title="¿Vaciar todos los archivados?"
        description="Esta acción eliminará de forma permanente todos los archivos archivados. No se podrá deshacer."
        confirmText="Vaciar todo"
        cancelText="Cancelar"
        variant="danger"
        busy={deletionBusy}
      />
    </div>
  );
});

export default ListFiles;

interface Props {
  arr: string[];
}
