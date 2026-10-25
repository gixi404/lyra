import { Edit2 as EditIcon, Archive as TrashIcon, MoreVertical, Info, FileDown } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { animated, useTransition } from "@react-spring/web";
import { twMerge } from "tailwind-merge";
import { downloadDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
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
import { useShallow } from "zustand/react/shallow";
import Modal from "./Modal";
import ModalInfo from "./ModalInfo";

function MenuFile({ fileName }: Props): Component {
  const d = translations(),
    { files: filesArr, editedFile } = fileStore(
      useShallow(state => ({ files: state.files, editedFile: state.editedFile }))
    ),
    files: string[] = filesArr,
    { renameFile, resolveDisplayName, readFile } = useFile(),
    { setItem } = useStorage(),
    { myPaper } = usePreferences(),
    { isDay } = themes(),
    [menuOpen, setMenuOpen] = useState<boolean>(false),
    [isInfoOpen, setIsInfoOpen] = useState<boolean>(false),
    [isEditOpen, setIsEditOpen] = useState<boolean>(false),
    [isTrashOpen, setIsTrashOpen] = useState<boolean>(false),
    menuRef = useRef<HTMLDivElement>(null);

  const menuTransitions = useTransition(menuOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

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
      const { jsPDF } = await import("jspdf");

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

  function handleEditConfirm(value?: string): void {
    if (!value) return notification("error", d.InvalidName);
    const sanitizedName: string = sanitizeFileName(getEditableFileName(value));
    if (!nameIsValid(sanitizedName)) return;

    const nextDisplayName: string = resolveDisplayName(sanitizedName, fileName);
    if (nextDisplayName === fileName) {
      setIsEditOpen(false);
      return;
    }

    if (files.includes(nextDisplayName)) {
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

      {menuTransitions(
        (styles, item) =>
          item && (
            <animated.div
              style={{
                opacity: styles.opacity,
                transform: styles.transform,
                transformOrigin: "top right",
              }}
              onClick={(e: SyntheticEvent) => e.stopPropagation()}
              className={twMerge(
                "absolute right-0 top-full mt-1 w-44 rounded-xl border shadow-xl py-1 z-50 flex flex-col text-xs font-medium",
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
              setIsEditOpen(true);
            }}
            className={twMerge(
              "flex items-center gap-x-2.5 px-3 py-2 text-left transition-colors w-full cursor-pointer",
              isDay
                ? "hover:bg-neutral-100 hover:text-indigo-600"
                : "hover:bg-zinc-800 hover:text-sky-400"
            )}
          >
            <EditIcon size={14} />
            <span>{d.EditName ?? "Editar"}</span>
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
              setIsTrashOpen(true);
            }}
            className={twMerge(
              "flex items-center gap-x-2.5 px-3 py-2 text-left transition-colors w-full cursor-pointer",
              isDay
                ? "hover:bg-rose-50 hover:text-rose-600"
                : "hover:bg-rose-500/20 hover:text-rose-400"
            )}
          >
            <TrashIcon size={14} />
            <span>{d.MoveToTrashLabel ?? "Archivar"}</span>
          </button>
        </animated.div>
      )
  )}

      <ModalInfo
        isOpen={isInfoOpen}
        onClose={() => setIsInfoOpen(false)}
        fileName={fileName}
      />

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
    </div>
  );
}

export default MenuFile;

interface Props {
  fileName: string;
}
