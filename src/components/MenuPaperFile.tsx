import { ArrowUpLeft as RecoveryIcon, Trash as RemoveIcon, Info, FileDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import useFile from "../hooks/useFile.ts";
import useStorage from "../hooks/useStorage.ts";
import { fileStore } from "../store/fileStore.ts";
import translations from "../utils/dictionary.ts";
import { notification } from "../utils/helpers.ts";
import { isWelcomeFileName, setWelcomeManuallyRestored } from "../utils/welcome.ts";
import { setArchiveState } from "../utils/archiveState.ts";
import { useSyncStore } from "../store/syncStore.ts";
import type { Component } from "../utils/types.ts";
import { useShallow } from "zustand/react/shallow";
import Modal from "./Modal.tsx";
import ModalInfo from "./ModalInfo.tsx";
import ContextMenu, { MenuItem, MenuSeparator } from "./ContextMenu.tsx";
import { runExclusiveDeletion } from "../utils/noteDeletion.ts";
import { displayNoteLabel, displayNoteName, displayNoteSuccessMessage } from "../utils/visibleNames.ts";
import { logger } from "../utils/logger.ts";

function MenuPaperFile({ fileName, individuallyArchived = true, archivedByFolder = false }: Props): Component {
  const d = translations(),
    { getItem } = useStorage(),
    { deleteFile, readFile } = useFile(),
    { editedFile, removeFileFromList } = fileStore(
      useShallow(state => ({
        editedFile: state.editedFile,
        removeFileFromList: state.removeFileFromList,
      }))
    ),
    [isInfoOpen, setIsInfoOpen] = useState<boolean>(false),
    [isRestoreOpen, setIsRestoreOpen] = useState<boolean>(false),
    [isRestoring, setIsRestoring] = useState<boolean>(false),
    restoringRef = useRef(false),
    [isDeleteOpen, setIsDeleteOpen] = useState<boolean>(false),
    isDeleting = fileStore(state => state.deletingFiles.includes(fileName)),
    isEmptyingArchived = fileStore(state => state.isEmptyingArchived),
    deletionBusy = isDeleting || isEmptyingArchived,
    mountedRef = useRef(false);
  const canRecoverIndividually = individuallyArchived || !archivedByFolder;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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
      const title = displayNoteName(fileName);
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
      notification("success", `${displayNoteLabel(fileName)} se exportó a PDF`);

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
      notification("error", `No se pudo exportar ${displayNoteLabel(fileName)} a PDF`);
    }
  }

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
      notification("error", `No se pudo recuperar ${displayNoteLabel(restoringName)}`);
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
        notification("success", displayNoteSuccessMessage(name, "deleted"));
        fileStore.getState().scheduleExitAnimation(name, () => {
          removeFileFromList(name);
          editedFile();
        });
      },
      failed: error => {
        logger.error("Could not delete note:", error);
        if (mountedRef.current) setIsDeleteOpen(false);
        notification("error", `No se pudo eliminar ${displayNoteLabel(fileName)}`);
      },
    });
  }

  return (
    <div className="relative flex items-center">
      <ContextMenu label="Opciones" title="Opciones" reveal="hover">
        <MenuItem
          icon={FileDown}
          label="Exportar"
          onSelect={() => void handleExportPDF()}
        />

        <MenuSeparator />

        <MenuItem
          icon={RecoveryIcon}
          label={d.Recover ?? "Restaurar"}
          tone="success"
          disabled={!canRecoverIndividually}
          title={!canRecoverIndividually ? "Recupera primero la carpeta que contiene esta nota" : undefined}
          onSelect={() => {
            if (!canRecoverIndividually) return;
            setIsRestoreOpen(true);
          }}
        />

        <MenuSeparator />

        <MenuItem
          icon={RemoveIcon}
          label={d.Delete ?? "Eliminar"}
          tone="danger"
          onSelect={() => setIsDeleteOpen(true)}
        />

        <MenuSeparator />

        <MenuItem
          icon={Info}
          label="Información"
          onSelect={() => setIsInfoOpen(true)}
        />
      </ContextMenu>

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
        description={`"${displayNoteName(fileName)}"`}
        confirmText={d.Recover}
        cancelText={d.Cancel}
        busy={isRestoring}
      />

      <Modal
        isOpen={isDeleteOpen}
        onClose={() => { if (!deletionBusy) setIsDeleteOpen(false); }}
        onConfirm={handleDeleteConfirm}
        title={d.DeleteQuestion}
        description={`"${displayNoteName(fileName)}"`}
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
  individuallyArchived?: boolean;
  archivedByFolder?: boolean;
}
