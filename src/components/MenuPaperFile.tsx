import { ArrowUpLeft as RecoveryIcon, Trash as RemoveIcon, MoreVertical, Info, FileDown } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { jsPDF } from "jspdf";
import { downloadDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { fileStore } from "../store/fileStore";
import translations from "../utils/dictionary";
import { notification, themes } from "../utils/helpers";
import type { Component } from "../utils/types";
import { useShallow } from "zustand/react/shallow";
import Modal from "./Modal";
import ModalInfo from "./ModalInfo";

function MenuPaperFile({ fileName }: Props): Component {
  const d = translations(),
    { isDay } = themes(),
    { setItem } = useStorage(),
    { myPaper } = usePreferences(),
    { deleteFile, readFile } = useFile(),
    { editedFile, removeFileFromList, files } = fileStore(
      useShallow(state => ({
        editedFile: state.editedFile,
        removeFileFromList: state.removeFileFromList,
        files: state.files,
      }))
    ),
    [menuOpen, setMenuOpen] = useState<boolean>(false),
    [isInfoOpen, setIsInfoOpen] = useState<boolean>(false),
    [isRestoreOpen, setIsRestoreOpen] = useState<boolean>(false),
    [isDeleteOpen, setIsDeleteOpen] = useState<boolean>(false),
    menuRef = useRef<HTMLDivElement>(null);

  function sanitizePdfText(text: string): string {
    return text
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2026/g, "...")
      .replace(/\u2022/g, "*")
      .normalize("NFC");
  }

  async function handleExportPDF(): Promise<void> {
    try {
      const content = await readFile(fileName);
      const title = fileName.replace(/\.(txt|md)$/i, "");

      const doc = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
      });

      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text(sanitizePdfText(title), 20, 20);

      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");

      const maxWidth = 170;
      const sanitizedContent = sanitizePdfText(content || "");
      const lines = doc.splitTextToSize(sanitizedContent, maxWidth);

      let y = 30;
      const lineHeight = 6;
      const pageHeight = 280;

      for (let i = 0; i < lines.length; i++) {
        if (y > pageHeight) {
          doc.addPage();
          y = 20;
        }
        doc.text(lines[i], 20, y);
        y += lineHeight;
      }

      doc.save(`${title}.pdf`);
      notification("success", "Archivo exportado a PDF correctamente");

      try {
        const downloadsPath = await downloadDir();
        if (downloadsPath) {
          await invoke("open_folder", { path: downloadsPath });
        }
      } catch (openErr) {
        console.warn("Could not open Downloads folder:", openErr);
      }
    } catch (err) {
      console.error("Error exporting PDF:", err);
      notification("error", "Error al exportar archivo");
    }
  }

  useEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };

    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  function handleRestoreConfirm(): void {
    const updatedPaper: string[] = myPaper(files).filter(
      (f: string) => f !== fileName
    );
    setItem("paper", JSON.stringify(updatedPaper));
    notification("success", d.FileRecovered);
    setIsRestoreOpen(false);
    editedFile();
  }

  async function handleDeleteConfirm(): Promise<void> {
    setIsDeleteOpen(false);
    try {
      await deleteFile(fileName);
      const updatedPaper: string[] = myPaper(files).filter(
        (f: string) => f !== fileName
      );
      removeFileFromList(fileName);
      setItem("paper", JSON.stringify(updatedPaper));
      editedFile();
      notification("success", d.DeletedFile);
    } catch {
      notification("error", "Error al eliminar el archivo");
    }
  }

  return (
    <div className="relative flex items-center" ref={menuRef}>
      <button
        type="button"
        onClick={(e: SyntheticEvent) => {
          e.stopPropagation();
          setMenuOpen(prev => !prev);
        }}
        className={twMerge(
          "p-1 rounded-md transition-colors cursor-pointer flex items-center justify-center",
          isDay
            ? "text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200/50"
            : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80"
        )}
        aria-label="Opciones"
      >
        <MoreVertical size={16} />
      </button>

      {menuOpen && (
        <div
          onClick={(e: SyntheticEvent) => e.stopPropagation()}
          className={twMerge(
            "absolute right-0 top-full mt-1 w-44 rounded-xl border shadow-xl py-1 z-50 flex flex-col text-xs font-medium animate-in fade-in duration-100",
            isDay
              ? "bg-white/95 border-neutral-200 text-neutral-700 shadow-neutral-300/40 backdrop-blur-md"
              : "bg-zinc-900/95 border-zinc-700/80 text-zinc-200 shadow-black/50 backdrop-blur-md"
          )}
        >
          <button
            type="button"
            onClick={(e: SyntheticEvent) => {
              e.stopPropagation();
              setMenuOpen(false);
              setIsInfoOpen(true);
            }}
            className={twMerge(
              "flex items-center gap-x-2.5 px-3 py-2 text-left transition-colors w-full cursor-pointer",
              isDay
                ? "hover:bg-neutral-100 hover:text-indigo-600"
                : "hover:bg-zinc-800 hover:text-sky-400"
            )}
          >
            <Info size={14} />
            <span>Información</span>
          </button>

          <div
            className={twMerge(
              "my-1 border-t",
              isDay ? "border-neutral-100" : "border-zinc-800/80"
            )}
          />

          <button
            type="button"
            onClick={(e: SyntheticEvent) => {
              e.stopPropagation();
              setMenuOpen(false);
              void handleExportPDF();
            }}
            className={twMerge(
              "flex items-center gap-x-2.5 px-3 py-2 text-left transition-colors w-full cursor-pointer",
              isDay
                ? "hover:bg-neutral-100 hover:text-indigo-600"
                : "hover:bg-zinc-800 hover:text-sky-400"
            )}
          >
            <FileDown size={14} />
            <span>Exportar</span>
          </button>

          <div
            className={twMerge(
              "my-1 border-t",
              isDay ? "border-neutral-100" : "border-zinc-800/80"
            )}
          />

          <button
            type="button"
            onClick={(e: SyntheticEvent) => {
              e.stopPropagation();
              setMenuOpen(false);
              setIsRestoreOpen(true);
            }}
            className={twMerge(
              "flex items-center gap-x-2.5 px-3 py-2 text-left transition-colors w-full cursor-pointer",
              isDay
                ? "hover:bg-emerald-50 hover:text-emerald-600"
                : "hover:bg-emerald-500/20 hover:text-emerald-400"
            )}
          >
            <RecoveryIcon size={15} />
            <span>{d.Recover ?? "Restaurar"}</span>
          </button>

          <div
            className={twMerge(
              "my-1 border-t",
              isDay ? "border-neutral-100" : "border-zinc-800/80"
            )}
          />

          <button
            type="button"
            onClick={(e: SyntheticEvent) => {
              e.stopPropagation();
              setMenuOpen(false);
              setIsDeleteOpen(true);
            }}
            className={twMerge(
              "flex items-center gap-x-2.5 px-3 py-2 text-left transition-colors w-full cursor-pointer",
              isDay
                ? "hover:bg-rose-50 hover:text-rose-600"
                : "hover:bg-rose-500/20 hover:text-rose-400"
            )}
          >
            <RemoveIcon size={14} />
            <span>{d.Delete ?? "Eliminar"}</span>
          </button>
        </div>
      )}

      <ModalInfo
        isOpen={isInfoOpen}
        onClose={() => setIsInfoOpen(false)}
        fileName={fileName}
      />

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
    </div>
  );
}

export default MenuPaperFile;

interface Props {
  fileName: string;
}
