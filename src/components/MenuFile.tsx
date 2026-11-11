import { Edit2 as EditIcon, Archive as TrashIcon, Info, FileDown, Move as MoveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import useFile from "../hooks/useFile.ts";
import { setArchiveState } from "../utils/archiveState.ts";
import { useSyncStore } from "../store/syncStore.ts";
import { fileStore } from "../store/fileStore.ts";
import translations from "../utils/dictionary.ts";
import {
  getEditableFileName,
  nameIsValid,
  notification,
} from "../utils/helpers.ts";
import type { Component } from "../utils/types.ts";
import { useShallow } from "zustand/react/shallow";
import Modal from "./Modal.tsx";
import ModalInfo from "./ModalInfo.tsx";
import MoveItemDialog from "./MoveItemDialog.tsx";
import ContextMenu, { MenuItem, MenuSeparator } from "./ContextMenu.tsx";
import { getFileBaseName, getFileDirectory, noteLabel, noteTitle } from "../utils/noteName.ts";
import { logger } from "../utils/logger.ts";

function MenuFile({ fileName }: Props): Component {
  const d = translations(),
    { files: filesArr, editedFile } = fileStore(
      useShallow(state => ({ files: state.files, editedFile: state.editedFile }))
    ),
    files: string[] = filesArr,
    { renameFile, resolveDisplayName, readFile } = useFile(),
    [isInfoOpen, setIsInfoOpen] = useState<boolean>(false),
    [isMoveOpen, setIsMoveOpen] = useState<boolean>(false),
    [isEditOpen, setIsEditOpen] = useState<boolean>(false),
    [isTrashOpen, setIsTrashOpen] = useState<boolean>(false),
    [isArchiving, setIsArchiving] = useState<boolean>(false),
    archivingRef = useRef(false),
    mountedRef = useRef(false);

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

  function handleEditConfirm(value?: string): void {
    if (!value) return notification("error", d.InvalidName);
    const baseValue = getEditableFileName(value);
    if (!nameIsValid(baseValue)) return;

    const currentBaseName = getFileBaseName(fileName);
    const nextBaseWithExt: string = resolveDisplayName(baseValue, currentBaseName);
    const dir = getFileDirectory(fileName);
    const nextDisplayName: string = dir ? `${dir}/${nextBaseWithExt}` : nextBaseWithExt;

    if (nextDisplayName === fileName) {
      setIsEditOpen(false);
      return;
    }

    if (files.includes(nextDisplayName)) {
      notification("error", `${noteLabel(nextDisplayName)} ya existe`);
      return;
    }

    setIsEditOpen(false);
    renameFile(fileName, nextDisplayName)
      .catch(() => notification("error", `No se pudo renombrar ${noteLabel(fileName)}`));
  }

  async function handleTrashConfirm(): Promise<void> {
    if (archivingRef.current) return;
    archivingRef.current = true;
    setIsArchiving(true);
    const archivedName = fileName;
    fileStore.getState().retainForExit(archivedName, "active");
    try {
      const projection = await setArchiveState(archivedName, true);
      if (!projection.archivedNames.includes(archivedName)) {
        fileStore.getState().releaseRetainedExit(archivedName);
        if (mountedRef.current) setIsTrashOpen(false);
        return;
      }
      if (mountedRef.current) setIsTrashOpen(false);
      if (useSyncStore.getState().isConnected && navigator.onLine) {
        void useSyncStore.getState().syncNow(true, true);
      }

      fileStore.getState().scheduleExitAnimation(archivedName, () => {
        editedFile();
      });
    } catch (err) {
      logger.error("Error al persistir archivado de nota:", err);
      fileStore.getState().releaseRetainedExit(archivedName);
      if (mountedRef.current) setIsTrashOpen(false);
      notification("error", `No se pudo archivar ${noteLabel(archivedName)}`);
    } finally {
      archivingRef.current = false;
      if (mountedRef.current) setIsArchiving(false);
    }
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
          icon={EditIcon}
          label={d.EditName ?? "Renombrar"}
          onSelect={() => setIsEditOpen(true)}
        />

        <MenuSeparator />

        <MenuItem
          icon={MoveIcon}
          label="Mover a…"
          onSelect={() => setIsMoveOpen(true)}
        />

        <MenuSeparator />

        <MenuItem
          icon={TrashIcon}
          label={d.MoveToTrashLabel ?? "Archivar"}
          tone="danger"
          onSelect={() => setIsTrashOpen(true)}
        />

        <MenuSeparator />

        <MenuItem
          icon={Info}
          label="Información"
          onSelect={() => setIsInfoOpen(true)}
        />
      </ContextMenu>

      <MoveItemDialog
        isOpen={isMoveOpen}
        kind="file"
        itemName={fileName}
        onClose={() => setIsMoveOpen(false)}
      />
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
        initialValue={getEditableFileName(getFileBaseName(fileName))}
        confirmText={d.Change}
        cancelText={d.Cancel}
      />

      <Modal
        isOpen={isTrashOpen}
        onClose={() => { if (!isArchiving) setIsTrashOpen(false); }}
        onConfirm={handleTrashConfirm}
        title={d.MoveToTrash}
        description={`"${noteTitle(fileName)}"`}
        confirmText={d.Confirm}
        cancelText={d.Cancel}
        variant="danger"
        busy={isArchiving}
      />
    </div>
  );
}

export default MenuFile;

interface Props {
  fileName: string;
}
