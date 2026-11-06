import { ArrowUpLeft as RecoveryIcon, Trash as RemoveIcon, MoreVertical, Info, FileDown } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { animated, useTransition } from "@react-spring/web";
import { twMerge } from "tailwind-merge";
import { downloadDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import useFile from "../hooks/useFile";
import useStorage from "../hooks/useStorage";
import { fileStore } from "../store/fileStore";
import translations from "../utils/dictionary";
import { notification, themes } from "../utils/helpers";
import { isWelcomeFileName, setWelcomeManuallyRestored } from "../utils/welcome";
import { setArchiveState } from "../utils/archiveState";
import { useSyncStore } from "../store/syncStore";
import type { Component } from "../utils/types";
import { useShallow } from "zustand/react/shallow";
import Modal from "./Modal";
import ModalInfo from "./ModalInfo";
import { runExclusiveDeletion } from "../utils/noteDeletion";
import { noteLabel, noteSuccessMessage, noteTitle } from "../utils/noteName";
import { logger } from "../utils/logger.ts";

function MenuPaperFile({ fileName }: Props): Component {
  const d = translations(),
    { isDay } = themes(),
    { getItem } = useStorage(),
    { deleteFile, readFile } = useFile(),
    { editedFile, removeFileFromList } = fileStore(
      useShallow(state => ({
        editedFile: state.editedFile,
        removeFileFromList: state.removeFileFromList,
      }))
    ),
    [menuOpen, setMenuOpen] = useState<boolean>(false),
    [openUpwards, setOpenUpwards] = useState<boolean>(false),
    [isInfoOpen, setIsInfoOpen] = useState<boolean>(false),
    [isRestoreOpen, setIsRestoreOpen] = useState<boolean>(false),
    [isRestoring, setIsRestoring] = useState<boolean>(false),
    restoringRef = useRef(false),
    [isDeleteOpen, setIsDeleteOpen] = useState<boolean>(false),
    isDeleting = fileStore(state => state.deletingFiles.includes(fileName)),
    isEmptyingArchived = fileStore(state => state.isEmptyingArchived),
    deletionBusy = isDeleting || isEmptyingArchived,
    mountedRef = useRef(false),
    menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const menuTransitions = useTransition(menuOpen, {
    from: { opacity: 0, transform: `scale(0.96) translateY(${openUpwards ? "-4px" : "4px"})` },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: `scale(0.96) translateY(${openUpwards ? "-4px" : "4px"})` },
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
      const title = noteTitle(fileName);
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
      notification("success", `${noteLabel(fileName)} se exportó a PDF`);

      try {
        const downloadsPath = await downloadDir();
        if (downloadsPath) {
          await invoke("open_folder", { path: downloadsPath });
        }
      } catch (openErr) {
        logger.warn("Could not open Downloads folder:", openErr);
      }
    } catch (err) {
      logger.error("Error exporting PDF:", err);
      notification("error", `No se pudo exportar ${noteLabel(fileName)} a PDF`);
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

    const updatePosition = (): void => {
      if (!menuRef.current) return;
      const rect = menuRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenUpwards(spaceBelow < 200 && spaceAbove > spaceBelow);
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function handleRestoreConfirm(): Promise<void> {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setIsRestoring(true);
    const restoringName = fileName;
    fileStore.getState().retainForExit(restoringName, "paper");
    const isWelcome = isWelcomeFileName(restoringName);
    let prevWelcomeRestored = "false";

    try {
      prevWelcomeRestored = getItem("welcome_manually_restored", "false");
      if (isWelcome) setWelcomeManuallyRestored(true);
      const projection = await setArchiveState(restoringName, false);
      if (projection.archivedNames.includes(restoringName)) {
        throw new Error("The note remains archived after a concurrent change");
      }
      if (mountedRef.current) setIsRestoreOpen(false);
      if (useSyncStore.getState().isConnected && navigator.onLine) {
        void useSyncStore.getState().syncNow(true, true);
      }

      fileStore.getState().scheduleExitAnimation(restoringName, () => {
        editedFile();
      });
    } catch (err) {
      logger.error("Error al persistir recuperación de nota:", err);
      fileStore.getState().releaseRetainedExit(restoringName);
      if (isWelcome) {
        try { setWelcomeManuallyRestored(prevWelcomeRestored === "true"); }
        catch (restoreError) { logger.warn("Could not restore welcome preference:", restoreError); }
      }
      if (mountedRef.current) setIsRestoreOpen(false);
      notification("error", `No se pudo recuperar ${noteLabel(restoringName)}`);
    } finally {
      restoringRef.current = false;
      if (mountedRef.current) setIsRestoring(false);
    }
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (fileStore.getState().isEmptyingArchived) return;
    await runExclusiveDeletion(fileName, {
      setBusy: busy => fileStore.getState().setDeletingFile(fileName, busy),
      retain: name => fileStore.getState().retainForExit(name, "paper"),
      release: name => fileStore.getState().releaseRetainedExit(name),
      deleteNote: deleteFile,
      confirmed: name => {
        if (mountedRef.current) setIsDeleteOpen(false);
        notification("success", noteSuccessMessage(name, "deleted"));
        fileStore.getState().scheduleExitAnimation(name, () => {
          removeFileFromList(name);
          editedFile();
        });
      },
      failed: error => {
        logger.error("Could not delete note:", error);
        if (mountedRef.current) setIsDeleteOpen(false);
        notification("error", `No se pudo eliminar ${noteLabel(fileName)}`);
      },
    });
  }

  return (
    <div className="relative flex items-center" ref={menuRef}>
      <button
        type="button"
        onClick={(e: SyntheticEvent) => {
          e.stopPropagation();
          if (!menuOpen && menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;
            setOpenUpwards(spaceBelow < 200 && spaceAbove > spaceBelow);
          }
          setMenuOpen(prev => !prev);
        }}
        className={twMerge(
          "p-1 rounded-md transition-all duration-150 active:scale-95 cursor-pointer flex items-center justify-center",
          isDay
            ? "text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200/50"
            : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80"
        )}
        aria-label="Opciones"
        title="Opciones"
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
                transformOrigin: openUpwards ? "bottom right" : "top right",
                backgroundColor: isDay ? "#ffffff" : "#18181b",
              }}
              onClick={(e: SyntheticEvent) => e.stopPropagation()}
              className={twMerge(
                "absolute right-0 w-44 rounded-xl border py-1 z-50 flex flex-col text-xs font-medium",
                openUpwards ? "bottom-full mb-1" : "top-full mt-1",
                isDay
                  ? "border-neutral-200 text-neutral-700 shadow-xl shadow-neutral-400/30"
                  : "border-zinc-700 text-zinc-200 shadow-2xl shadow-black/80"
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
                ? "hover:bg-neutral-100 hover:text-accent-text"
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
                ? "hover:bg-neutral-100 hover:text-accent-text"
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
                ? "hover:bg-danger-subtle hover:text-danger-text"
                : "hover:bg-rose-500/20 hover:text-rose-400"
            )}
          >
            <RemoveIcon size={14} />
            <span>{d.Delete ?? "Eliminar"}</span>
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
        isOpen={isRestoreOpen}
        onClose={() => { if (!isRestoring) setIsRestoreOpen(false); }}
        onConfirm={handleRestoreConfirm}
        title={d.RestoreQuestion}
        description={`"${noteTitle(fileName)}"`}
        confirmText={d.Recover}
        cancelText={d.Cancel}
        busy={isRestoring}
      />

      <Modal
        isOpen={isDeleteOpen}
        onClose={() => { if (!deletionBusy) setIsDeleteOpen(false); }}
        onConfirm={handleDeleteConfirm}
        title={d.DeleteQuestion}
        description={`"${noteTitle(fileName)}"`}
        confirmText={d.Delete}
        cancelText={d.Cancel}
        variant="danger"
        busy={deletionBusy}
      />
    </div>
  );
}

export default MenuPaperFile;

interface Props {
  fileName: string;
}
