import { Edit2 as EditIcon, Archive as TrashIcon } from "lucide-react";
import { type SyntheticEvent, useState } from "react";
import { twMerge } from "tailwind-merge";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { fileStore } from "../store/fileStore";
import translations from "../utils/dictionary";
import {
  getEditableFileName,
  nameIsValid,
  notification,
  sanitizeFileName,
  themes,
} from "../utils/helpers";
import type { Component } from "../utils/types";
import { shallow } from "zustand/shallow";
import Modal from "./Modal";

function MenuFile({ fileName }: Props): Component {
  const d = translations(),
    { files: filesArr, editedFile } = fileStore(
      state => ({ files: state.files, editedFile: state.editedFile }),
      shallow
    ),
    files: string[] = filesArr,
    { renameFile, resolveDisplayName } = useFile(),
    { setItem } = useStorage(),
    { myPaper } = usePreferences(),
    { isDay } = themes(),
    [isEditOpen, setIsEditOpen] = useState(false),
    [isTrashOpen, setIsTrashOpen] = useState(false);

  function handleEditConfirm(value?: string): void {
    if (!value) return notification("error", d.InvalidName);
    if (!nameIsValid(value)) return;

    const sanitizedName: string = sanitizeFileName(getEditableFileName(value));
    const nextDisplayName: string = resolveDisplayName(sanitizedName, fileName);

    if (nextDisplayName !== fileName && files.includes(nextDisplayName)) {
      notification("error", d.NameAlreadyExists);
      return;
    }

    setIsEditOpen(false);
    renameFile(fileName, sanitizedName)
      .then(() => notification("success", d.EditedName))
      .catch(() => notification("error", d.InvalidName));
  }

  function handleTrashConfirm(): void {
    const currentPaper: string[] = myPaper(files);
    const updatedPaper: string[] = currentPaper.includes(fileName)
      ? currentPaper
      : [fileName, ...currentPaper];
    setItem("paper", JSON.stringify(updatedPaper));
    notification("success", d.SentToTrash);
    setIsTrashOpen(false);
    editedFile();
  }

  return (
    <>
      {!(isEditOpen || isTrashOpen) && (
        <div
          className={twMerge(
            "absolute right-1 top-1/2 -translate-y-1/2 items-center gap-x-1 p-1 rounded-xl shadow-md z-10 flex md:hidden md:group-hover:flex md:focus-within:flex",
            isDay
              ? "bg-white border border-neutral-200 text-neutral-600"
              : "bg-zinc-800 border border-zinc-700 text-zinc-300"
          )}
        >
          <button
            type="button"
            onClick={(e: SyntheticEvent) => {
              e.stopPropagation();
              setIsEditOpen(true);
            }}
            className={twMerge(
              "p-1.5 rounded-lg transition-colors",
              isDay
                ? "hover:bg-neutral-100 hover:text-indigo-600"
                : "hover:bg-zinc-700 hover:text-sky-400"
            )}
          >
            <EditIcon size={16} />
          </button>
          <button
            type="button"
            onClick={(e: SyntheticEvent) => {
              e.stopPropagation();
              setIsTrashOpen(true);
            }}
            className={twMerge(
              "p-1.5 rounded-lg transition-colors",
              isDay
                ? "hover:bg-rose-50 hover:text-rose-600"
                : "hover:bg-rose-500/20 hover:text-rose-400"
            )}
          >
            <TrashIcon size={16} />
          </button>
        </div>
      )}

      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        onConfirm={handleEditConfirm}
        title={d.EnterNewName}
        hasInput
        initialValue={getEditableFileName(fileName)}
        confirmText={d.Change}
        cancelText={d.Cancel}
      />

      <Modal
        isOpen={isTrashOpen}
        onClose={() => setIsTrashOpen(false)}
        onConfirm={handleTrashConfirm}
        title={d.MoveToTrash}
        description={`"${fileName.replace(/\.(txt|md)$/i, "")}"`}
        confirmText={d.Confirm}
        cancelText={d.Cancel}
        variant="danger"
      />
    </>
  );
}

export default MenuFile;

interface Props {
  fileName: string;
}
