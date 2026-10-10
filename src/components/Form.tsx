import translations from "../utils/dictionary";
import useFile from "../hooks/useFile";
import Modal from "./Modal";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { PAGES } from "../utils/consts";
import { searchStore } from "../store/searchStore";
import { twMerge } from "tailwind-merge";
import {
  Plus as AddIcon,
  ArrowDownAz,
  ArrowDownZa,
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
import { shallow } from "zustand/shallow";

function Form(): Component {
  const d = translations(),
    { goTo } = navigation(),
    { isDay } = themes(),
    { createFile, resolveDisplayName } = useFile(),
    { paperIsOpen, setPaperIsOpen } = configStore(
      state => ({
        paperIsOpen: state.paperIsOpen,
        setPaperIsOpen: state.setPaperIsOpen,
      }),
      shallow
    ),
    [isModalOpen, setIsModalOpen] = useState<boolean>(false),
    { search, setSearch, order, toggleOrder } = searchStore(
      state => ({
        search: state.search,
        setSearch: state.setSearch,
        order: state.order,
        toggleOrder: state.toggleOrder,
      }),
      shallow
    ),
    { updateListFiles, setSelectedFile, files } = fileStore(
      state => ({
        updateListFiles: state.updateListFiles,
        setSelectedFile: state.setSelectedFile,
        files: state.files,
      }),
      shallow
    ),
    isRepeated = (fileName: string): boolean => {
      const nextDisplayName: string = resolveDisplayName(fileName);
      return files.some((name: string) => name === nextDisplayName);
    };

  async function fileManagement(file: File): Promise<void> {
    const displayName: string = await createFile(file.name, file.content);
    const nextFile: File = { ...file, name: displayName };
    updateListFiles(displayName);
    setSelectedFile(nextFile);
    goTo(PAGES.file);
  }

  function handleCreateConfirm(value?: string): void {
    if (!value) return;
    const sanitizedName: string = sanitizeFileName(value);
    const displayName: string = resolveDisplayName(sanitizedName);

    if (paperIsOpen) {
      setIsModalOpen(false);
      return;
    }

    if (isRepeated(sanitizedName)) {
      notification("error", d.RepeatedItem);
      return;
    }

    if (!nameIsValid(sanitizedName)) {
      return;
    }

    setIsModalOpen(false);
    const file: File = {
      name: sanitizedName,
      content: `## ${displayName}\n\n`,
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
                  ? "bg-transparent text-neutral-900 placeholder:text-neutral-400 font-sans text-sm outline-none w-full"
                  : "bg-transparent text-zinc-100 placeholder:text-zinc-500 font-sans text-sm outline-none w-full"
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
              onClick={() => toggleOrder(!order)}
              className={`p-1.5 transition-colors rounded-lg ${
                isDay
                  ? "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
              }`}
            >
              {order ? (
                <ArrowDownAz size={18} strokeWidth={2} />
              ) : (
                <ArrowDownZa size={18} strokeWidth={2} />
              )}
            </button>

            <button
              type="button"
              onClick={setPaperIsOpen}
              className={twMerge(
                "p-1.5 transition-colors rounded-lg",
                isDay
                  ? "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60",
                paperIsOpen && (isDay ? "text-indigo-600 bg-indigo-50" : "text-sky-400 bg-sky-500/10")
              )}
            >
              <PaperIcon size={16} strokeWidth={2} />
            </button>

            {/* Botón celeste (+) */}
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="w-10 h-10 rounded-xl bg-[#00a8ff] hover:bg-[#0096e6] text-black font-semibold flex items-center justify-center shadow-lg shadow-[#00a8ff]/20 transition-transform active:scale-95 ml-1"
            >
              <AddIcon size={20} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </form>

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
