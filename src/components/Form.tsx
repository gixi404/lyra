import translations from "../utils/dictionary";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import Modal from "./Modal";
import ModalSort from "./ModalSort";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { PAGES } from "../utils/consts";
import { searchStore } from "../store/searchStore";
import { twMerge } from "tailwind-merge";
import {
  Plus as AddIcon,
  SlidersHorizontal,
  Search as SearchIcon,
  X as ClearIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  getEditableFileName,
  nameIsValid,
  navigation,
  normalize,
  notification,
  sanitizeFileName,
  themes,
} from "../utils/helpers";
import { setListScroll } from "../utils/listScroll";
import type { Component, File } from "../utils/types";
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
    { createFile, resolveDisplayName, readFile } = useFile(),
    searchInputRef = useRef<HTMLInputElement>(null),
    fileIsEdited = fileStore(state => state.fileIsEdited),
    { paperIsOpen, setPaperIsOpen } = configStore(
      useShallow(state => ({
        paperIsOpen: state.paperIsOpen,
        setPaperIsOpen: state.setPaperIsOpen,
      }))
    ),
    [isModalOpen, setIsModalOpen] = useState<boolean>(false),
    [isSortModalOpen, setIsSortModalOpen] = useState<boolean>(false),
    { search, setSearch } = searchStore(
      useShallow(state => ({
        search: state.search,
        setSearch: state.setSearch,
        order: state.order,
        toggleOrder: state.toggleOrder,
      }))
    ),
    { updateListFiles, setSelectedFile, files } = fileStore(
      useShallow(state => ({
        updateListFiles: state.updateListFiles,
        setSelectedFile: state.setSelectedFile,
        files: state.files,
      }))
    ),
    paperFiles = useMemo(() => myPaper(files), [files, fileIsEdited]),
    paperSet = useMemo(() => new Set(paperFiles), [paperFiles]),
    hasArchivedFiles = paperFiles.length > 0,
    isRepeated = (fileName: string): boolean => {
      const nextDisplayName: string = resolveDisplayName(fileName);
      return files.some((name: string) => name === nextDisplayName);
    };

  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent): void => {
      const activeEl = document.activeElement;
      const isInputActive =
        activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA");
      if (isModalOpen || isSortModalOpen) return;

      if (
        (e.key === "/" && !isInputActive) ||
        ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F"))
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (e.key === "Escape" && !isInputActive && paperIsOpen) {
        e.preventDefault();
        setPaperIsOpen(false);
        return;
      }
    };

    window.addEventListener("keydown", handleGlobalShortcuts);
    return () => window.removeEventListener("keydown", handleGlobalShortcuts);
  }, [isModalOpen, isSortModalOpen]);

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (search) {
        setSearch("");
      } else if (paperIsOpen) {
        setPaperIsOpen(false);
      }
      searchInputRef.current?.blur();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const source = paperIsOpen ? paperFiles : files.filter(f => !paperSet.has(f));
      const normalizedSearch = normalize(search);
      const matches = source.filter(f => normalize(f).includes(normalizedSearch));

      if (matches.length === 1) {
        void (async () => {
          try {
            const currentY =
              window.pageYOffset ||
              window.scrollY ||
              document.documentElement.scrollTop ||
              document.body.scrollTop ||
              0;
            if (currentY > 0) {
              setListScroll(currentY);
            }
            const fileName = matches[0];
            const fileContent = await readFile(fileName);
            setSelectedFile({ name: fileName, content: fileContent });
            goTo(PAGES.file);
          } catch {
            notification("error", "No se pudo abrir el archivo");
          }
        })();
      }
    }
  }

  async function fileManagement(file: File): Promise<void> {
    try {
      const currentY =
        window.pageYOffset ||
        window.scrollY ||
        document.documentElement.scrollTop ||
        document.body.scrollTop ||
        0;
      if (currentY > 0) {
        setListScroll(currentY);
      }
      const displayName: string = await createFile(file.name, file.content);
      const nextFile: File = { ...file, name: displayName };
      updateListFiles(displayName);
      setSelectedFile(nextFile);
      goTo(PAGES.file);
    } catch {
      notification("error", "Error al crear el archivo");
    }
  }

  function handleCreateConfirm(value?: string): void {
    if (!value) return;
    const sanitizedName: string = sanitizeFileName(value);

    if (!nameIsValid(sanitizedName)) {
      return;
    }

    if (isRepeated(sanitizedName)) {
      notification("error", d.RepeatedItem);
      return;
    }

    setIsModalOpen(false);
    if (paperIsOpen) {
      setPaperIsOpen(false);
    }
    const titleWithoutExtension = getEditableFileName(sanitizedName);
    const initialContent = `# ${titleWithoutExtension}\n\n`;
    const file: File = {
      name: sanitizedName,
      content: initialContent,
      initialCaretPos: initialContent.length,
    };
    void fileManagement(file);
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
                isDay ? "text-neutral-400" : "text-zinc-500"
              }`}
            />
            <input
              ref={searchInputRef}
              type="text"
              className={twMerge(
                isDay
                  ? "bg-transparent text-neutral-900 placeholder:text-neutral-400 text-sm outline-none w-full"
                  : "bg-transparent text-zinc-100 placeholder:text-zinc-500 text-sm outline-none w-full"
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
              onClick={() => setPaperIsOpen()}
              title={paperIsOpen ? "Ver documentos" : "Archivados"}
              aria-label={paperIsOpen ? "Ver documentos" : "Archivados"}
              className={twMerge(
                "p-1.5 transition-all duration-150 rounded-lg cursor-pointer active:scale-95",
                isDay
                  ? "text-neutral-600 hover:text-indigo-600 hover:bg-indigo-50"
                  : "text-zinc-400 hover:text-sky-400 hover:bg-sky-500/10",
                paperIsOpen && (isDay ? "text-indigo-600 bg-indigo-50" : "text-sky-400 bg-sky-500/10")
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
              onClick={() => setIsModalOpen(true)}
              title="Crear nuevo archivo"
              className="w-10 h-10 rounded-xl bg-[#00a8ff] hover:bg-[#0096e6] text-black font-semibold flex items-center justify-center transition-all duration-150 active:scale-95 ml-1 cursor-pointer shadow-sm"
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

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleCreateConfirm}
        title={d.EnterTheFileName}
        hasInput
        inputPlaceholder="¿Cómo se llama la obra maestra?"
        confirmText={d.Add}
        cancelText={d.Cancel}
      />
    </>
  );
}

export default Form;
