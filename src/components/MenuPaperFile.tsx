import { ArrowUpLeft as RecoveryIcon, Trash as RemoveIcon } from "lucide-react";
import { type SyntheticEvent, useState } from "react";
import { twMerge } from "tailwind-merge";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { fileStore } from "../store/fileStore";
import translations from "../utils/dictionary";
import { notification, themes } from "../utils/helpers";
import type { Component } from "../utils/types";
import { shallow } from "zustand/shallow";
import Modal from "./Modal";

function MenuPaperFile({ fileName }: Props): Component {
  const d = translations(),
    { isDay } = themes(),
    { setItem } = useStorage(),
    { myPaper } = usePreferences(),
    { deleteFile } = useFile(),
    { editedFile, removeFileFromList, files } = fileStore(
      state => ({
        editedFile: state.editedFile,
        removeFileFromList: state.removeFileFromList,
        files: state.files,
      }),
      shallow
    ),
    [isRestoreOpen, setIsRestoreOpen] = useState(false),
    [isDeleteOpen, setIsDeleteOpen] = useState(false);

  function handleRestoreConfirm(): void {
    const updatedPaper: string[] = myPaper(files).filter(
      (f: string) => f !== fileName
    );
    setItem("paper", JSON.stringify(updatedPaper));
    notification("success", d.FileRecovered);
    setIsRestoreOpen(false);
    editedFile();
  }

  function handleDeleteConfirm(): void {
    const updatedPaper: string[] = myPaper(files).filter(
      (f: string) => f !== fileName
    );
    removeFileFromList(fileName);
    setItem("paper", JSON.stringify(updatedPaper));
    deleteFile(fileName);
    setIsDeleteOpen(false);
    editedFile();
    notification("success", d.DeletedFile);
  }

  return (
    <>
      {!(isRestoreOpen || isDeleteOpen) && (
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
              setIsRestoreOpen(true);
            }}
            className={twMerge(
              "p-1.5 rounded-lg transition-colors",
              isDay
                ? "hover:bg-emerald-50 hover:text-emerald-600"
                : "hover:bg-emerald-500/20 hover:text-emerald-400"
            )}
          >
            <RecoveryIcon size={17} />
          </button>
          <button
            type="button"
            onClick={(e: SyntheticEvent) => {
              e.stopPropagation();
              setIsDeleteOpen(true);
            }}
            className={twMerge(
              "p-1.5 rounded-lg transition-colors",
              isDay
                ? "hover:bg-rose-50 hover:text-rose-600"
                : "hover:bg-rose-500/20 hover:text-rose-400"
            )}
          >
            <RemoveIcon size={16} />
          </button>
        </div>
      )}

      <Modal
        isOpen={isRestoreOpen}
        onClose={() => setIsRestoreOpen(false)}
        onConfirm={handleRestoreConfirm}
        title={d.RestoreQuestion}
        description={`"${fileName.replace(/\.(txt|md)$/i, "")}"`}
        confirmText={d.Recover}
        cancelText={d.Cancel}
      />

      <Modal
        isOpen={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        onConfirm={handleDeleteConfirm}
        title={d.DeleteQuestion}
        description={`"${fileName.replace(/\.(txt|md)$/i, "")}"`}
        confirmText={d.Delete}
        cancelText={d.Cancel}
        variant="danger"
      />
    </>
  );
}

export default MenuPaperFile;

interface Props {
  fileName: string;
}
