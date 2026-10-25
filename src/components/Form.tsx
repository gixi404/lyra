import translations from "../utils/dictionary";
import useFile from "../hooks/useFile";
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
  Archive as PaperIcon,
  Search as SearchIcon,
  X as ClearIcon,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  nameIsValid,
  navigation,
  notification,
  sanitizeFileName,
  themes,
} from "../utils/helpers";
import type { Component, File } from "../utils/types";
import { useShallow } from "zustand/react/shallow";

function Form(): Component {
  const d = translations(),
    { goTo } = navigation(),
    { isDay } = themes(),
    { createFile, resolveDisplayName } = useFile(),
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
    isRepeated = (fileName: string): boolean => {
      const nextDisplayName: string = resolveDisplayName(fileName);
      return files.some((name: string) => name === nextDisplayName);
    };

  async function fileManagement(file: File): Promise<void> {
    try {
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

    if (paperIsOpen) {
      setIsModalOpen(false);
      return;
    }

    if (!nameIsValid(sanitizedName)) {
      return;
    }

    if (isRepeated(sanitizedName)) {
      notification("error", d.RepeatedItem);
      return;
    }

    setIsModalOpen(false);
    const file: File = {
      name: sanitizedName,
      content: "",
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
              autoFocus
              type="text"
              className={twMerge(
                isDay
                  ? "bg-transparent text-neutral-900 placeholder:text-neutral-400 text-sm outline-none w-full"
                  : "bg-transparent text-zinc-100 placeholder:text-zinc-500 text-sm outline-none w-full"
              )}
              placeholder={d.Search + "..."}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className={`absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
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
              className={`p-1.5 transition-colors rounded-lg cursor-pointer ${
                isDay
                  ? "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
              }`}
            >
              <SlidersHorizontal size={19} strokeWidth={2} />
            </button>

            <button
              type="button"
              onClick={setPaperIsOpen}
              className={twMerge(
                "p-1.5 transition-colors rounded-lg cursor-pointer",
                isDay
                  ? "text-neutral-600 hover:text-indigo-600 hover:bg-indigo-50"
                  : "text-zinc-400 hover:text-sky-400 hover:bg-sky-500/10",
                paperIsOpen && (isDay ? "text-indigo-600 bg-indigo-50" : "text-sky-400 bg-sky-500/10")
              )}
            >
              <PaperIcon size={18} strokeWidth={2} />
            </button>

            {/* Botón celeste (+) */}
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="w-10 h-10 rounded-xl bg-[#00a8ff] hover:bg-[#0096e6] text-black font-semibold flex items-center justify-center transition-transform active:scale-95 ml-1 cursor-pointer"
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
