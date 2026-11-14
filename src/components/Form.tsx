import translations from "../utils/dictionary.ts";
import useFile from "../hooks/useFile.ts";
import usePreferences from "../hooks/usePreferences.ts";
import ModalSort from "./ModalSort.tsx";
import CreateNoteDialog from "./CreateNoteDialog.tsx";
import { invoke } from "@tauri-apps/api/core";
import { configStore } from "../store/configStore.ts";
import { fileStore } from "../store/fileStore.ts";
import useStorage from "../hooks/useStorage.ts";
import { expandAncestorsForNote, expandParentPath, readFolderExpandedState } from "../utils/folderTree.ts";
import { PAGES } from "../utils/consts.ts";
import { searchStore } from "../store/searchStore.ts";
import { twMerge } from "tailwind-merge";
import {
  Plus as AddIcon,
  SlidersHorizontal,
  Search as SearchIcon,
  X as ClearIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  navigation,
  normalize,
  notification,
  themes,
} from "../utils/helpers.ts";
import { commitVisibleName, resolveNewFolderPhysicalPath, resolveNewNotePhysicalPath, validateVisibleEntryName } from "../utils/visibleNameOps.ts";
import { displayNoteLabel, displayNoteName } from "../utils/visibleNames.ts";
import { getScrollPos, setListScroll } from "../utils/listScroll.ts";
import { getFileDirectory } from "../utils/noteName.ts";
import type { Component, File } from "../utils/types.ts";
import { useShallow } from "zustand/react/shallow";

interface ArchiveIconProps {
  size?: number;
  strokeWidth?: number;
  filled?: boolean;
}

function ArchiveIcon({ size = 18, strokeWidth = 2, filled = false }: ArchiveIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      {filled ? (
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M6.5 10 h11 v7 a1.5 1.5 0 0 1 -1.5 1.5 h-8 a1.5 1.5 0 0 1 -1.5 -1.5 v-7 z M9.5 12 a1 1 0 0 1 1 -1 h3 a1 1 0 0 1 1 1 a1 1 0 0 1 -1 1 h-3 a1 1 0 0 1 -1 -1 z"
          fill="currentColor"
          stroke="none"
        />
      ) : (
        <path d="M10 12h4" />
      )}
    </svg>
  );
}

function Form(): Component {
  const d = translations(),
    { goTo } = navigation(),
    { isDay } = themes(),
    { myPaper } = usePreferences(),
    { createFile, readFile } = useFile(),
    { setItem } = useStorage(),
    searchInputRef = useRef<HTMLInputElement>(null),
    { paperIsOpen, setPaperIsOpen } = configStore(
      useShallow(state => ({
        paperIsOpen: state.paperIsOpen,
        setPaperIsOpen: state.setPaperIsOpen,
      }))
    ),
    [isModalOpen, setIsModalOpen] = useState<boolean>(false),
    [initialFolder, setInitialFolder] = useState(""),
    [isSortModalOpen, setIsSortModalOpen] = useState<boolean>(false),
    { search, setSearch } = searchStore(
      useShallow(state => ({
        search: state.search,
        setSearch: state.setSearch,
        order: state.order,
        toggleOrder: state.toggleOrder,
      }))
    ),
    { setSelectedFile, files, folders } = fileStore(
      useShallow(state => ({
        setSelectedFile: state.setSelectedFile,
        files: state.files,
        folders: state.folders,
      }))
    ),
    paperFiles = useMemo(() => myPaper(files), [files, myPaper]),
    paperSet = useMemo(() => new Set(paperFiles), [paperFiles]),
    hasArchivedFiles = paperFiles.length > 0;

  useEffect(() => {
    const openInFolder = (event: Event) => {
      setInitialFolder((event as CustomEvent<string>).detail ?? "");
      setIsModalOpen(true);
    };
    window.addEventListener("lyra:create-note-in-folder", openInFolder);
    return () => window.removeEventListener("lyra:create-note-in-folder", openInFolder);
  }, []);

  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent): void => {
      const activeEl = document.activeElement;
      const isInputActive =
        activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA");

      // Respetar modales/diálogos abiertos: ellos tienen prioridad para cerrarse.
      const hasOpenDialog = Boolean(
        document.querySelector("#modal-root > div, [role='dialog'], .search-replace-modal")
      );
      if (isModalOpen || isSortModalOpen || hasOpenDialog) return;

      if (
        (e.key === "/" && !isInputActive) ||
        ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F"))
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      // Usar el estado actual del store para evitar closures desactualizadas.
      const isPaperOpen = configStore.getState().paperIsOpen;
      if (e.key === "Escape" && !isInputActive && isPaperOpen) {
        e.preventDefault();
        setListScroll(getScrollPos(), "paper");
        setPaperIsOpen(false);
        return;
      }
    };

    window.addEventListener("keydown", handleGlobalShortcuts);
    return () => window.removeEventListener("keydown", handleGlobalShortcuts);
  }, [isModalOpen, isSortModalOpen, setPaperIsOpen]);

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (search) {
        setSearch("");
      } else if (paperIsOpen) {
        setListScroll(getScrollPos(), "paper");
        setPaperIsOpen(false);
      }
      searchInputRef.current?.blur();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const source = paperIsOpen ? paperFiles : files.filter(f => !paperSet.has(f));
      const normalizedSearch = normalize(search);
      const matches = source.filter(f =>
        normalize(f).includes(normalizedSearch) || normalize(displayNoteName(f)).includes(normalizedSearch)
      );

      if (matches.length === 1) {
        void (async () => {
          try {
            const currentView = paperIsOpen ? "paper" : "active";
            setListScroll(getScrollPos(), currentView);
            const fileName = matches[0];
            const fileContent = await readFile(fileName);
            setSelectedFile({ name: fileName, content: fileContent });
            goTo(PAGES.file);
          } catch {
            notification("error", `No se pudo abrir ${displayNoteLabel(matches[0])}`);
          }
        })();
      }
    }
  }

  async function fileManagement(file: File, visibleSegment: string): Promise<void> {
    try {
      setListScroll(getScrollPos("active"), "active");
      const displayName: string = await createFile(file.name, file.content);
      // Confirmar nombre visible tras la creación física/identidad para que persista exactamente
      // (la detección de reutilización no debe eliminar el nombre visible recién asignado).
      commitVisibleName(displayName, "file", visibleSegment);
      const noteDir = getFileDirectory(displayName);
      const nextExpanded = expandAncestorsForNote(readFolderExpandedState(window.localStorage), noteDir);
      setItem("folderExpanded", JSON.stringify(nextExpanded));
      const nextFile: File = { ...file, name: displayName };
      setSelectedFile(nextFile);
      goTo(PAGES.file);
    } catch {
      notification("error", `No se pudo crear ${displayNoteLabel(file.name)}`);
    }
  }

  function handleCreateConfirm(value?: string, folder = ""): void {
    if (value === undefined || value === null) return;
    const validation = validateVisibleEntryName(value, "file");
    if (!validation.ok) {
      notification("error", validation.reason ?? d.InvalidName);
      return;
    }

    const { physicalPath, visibleSegment } = resolveNewNotePhysicalPath(value, folder);
    if (files.includes(physicalPath)) {
      notification("error", `${displayNoteLabel(physicalPath)} ya existe`);
      return;
    }

    setIsModalOpen(false);
    if (paperIsOpen) {
      setPaperIsOpen(false);
    }
    // Derive heading from visible segment without hidden extension; keep technical ext out of heading.
    let headingTitle: string;
    const lowerVis = visibleSegment.toLowerCase();
    if (lowerVis.endsWith(".txt") || lowerVis.endsWith(".md")) {
      headingTitle = visibleSegment.slice(0, -4);
    } else {
      const dot = visibleSegment.lastIndexOf(".");
      headingTitle = dot > 0 ? visibleSegment.slice(0, dot) : visibleSegment;
    }
    const initialContent = `# ${headingTitle}\n\n`;
    const file: File = {
      name: physicalPath,
      content: initialContent,
      initialCaretPos: initialContent.length,
    };
    void fileManagement(file, visibleSegment);
  }

  async function createFolder(parent: string, name: string): Promise<string> {
    const validation = validateVisibleEntryName(name, "folder");
    if (!validation.ok) throw new Error(validation.reason ?? d.InvalidName);
    const { physicalPath, visibleSegment } = resolveNewFolderPhysicalPath(name, parent);
    await invoke("create_folder", { relativePath: physicalPath });
    fileStore.getState().setFolders([...fileStore.getState().folders, physicalPath]);
    commitVisibleName(physicalPath, "folder", visibleSegment);
    if (parent) {
      const nextExpanded = expandParentPath(readFolderExpandedState(window.localStorage), parent);
      setItem("folderExpanded", JSON.stringify(nextExpanded));
    }
    return physicalPath;
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
  }

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col justify-center items-center w-[680px] max-w-full"
      >
        <div
          className={twMerge(
            "flex items-center justify-between w-full h-12 px-1 gap-x-4 border-b pb-2",
            isDay ? "border-neutral-200/80" : "border-zinc-800/60"
          )}
        >
          {/* Lupa + Input de Búsqueda */}
          <div className="relative flex-1 flex items-center pr-8">
            <SearchIcon
              size={17}
              className={`shrink-0 pointer-events-none mr-3 ${
                isDay ? "text-neutral-500" : "text-zinc-400"
              }`}
            />
            <input
              ref={searchInputRef}
              type="text"
              className={twMerge(
                isDay
                  ? "bg-transparent text-neutral-900 placeholder:text-neutral-600 text-sm outline-none w-full"
                  : "bg-transparent text-zinc-100 placeholder:text-zinc-400 text-sm outline-none w-full"
              )}
              placeholder={d.Search + "... (/)"}
              title="Buscar (Ctrl+F o /)"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                title="Limpiar búsqueda (Esc)"
                className={`absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded transition-colors active:scale-95 ${
                  isDay
                    ? "text-neutral-400 hover:text-neutral-600"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <ClearIcon size={14} />
              </button>
            )}
          </div>

          {/* Grupo de Iconos de Acción Derecha */}
          <div className="flex items-center gap-x-3 sm:gap-x-4 shrink-0">
            <button
              type="button"
              onClick={() => setIsSortModalOpen(true)}
              title="Ordenar archivos"
              className={`p-1.5 transition-all duration-150 rounded-lg cursor-pointer active:scale-95 ${
                isDay
                  ? "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
              }`}
            >
              <SlidersHorizontal size={19} strokeWidth={2} />
            </button>

            <button
              type="button"
              onClick={() => {
                setListScroll(getScrollPos(), paperIsOpen ? "paper" : "active");
                setPaperIsOpen();
              }}
              title={paperIsOpen ? "Ver documentos" : "Archivados"}
              aria-label={paperIsOpen ? "Ver documentos" : "Archivados"}
              className={twMerge(
                "p-1.5 transition-all duration-150 rounded-lg cursor-pointer active:scale-95",
                isDay
                  ? "text-neutral-600 hover:text-accent-text hover:bg-accent-subtle"
                  : "text-zinc-400 hover:text-sky-400 hover:bg-sky-500/10",
                paperIsOpen && (isDay ? "text-accent-text bg-accent-subtle" : "text-sky-400 bg-sky-500/10")
              )}
            >
              <ArchiveIcon
                size={18}
                strokeWidth={2}
                filled={hasArchivedFiles}
              />
            </button>

            {/* Botón celeste (+) */}
            <button
              type="button"
              onClick={() => { setInitialFolder(""); setIsModalOpen(true); }}
              title="Crear nuevo archivo"
              className="w-10 h-10 rounded-xl bg-accent hover:bg-accent-hover text-ink font-semibold flex items-center justify-center transition-all duration-150 active:scale-95 ml-1 cursor-pointer shadow-sm"
            >
              <AddIcon size={20} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </form>

      <ModalSort
        isOpen={isSortModalOpen}
        onClose={() => setIsSortModalOpen(false)}
      />

      <CreateNoteDialog
        isOpen={isModalOpen}
        folders={folders}
        initialFolder={initialFolder}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateConfirm}
        onCreateFolder={createFolder}
      />
    </>
  );
}

export default Form;
