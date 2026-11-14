import { Edit2 as EditIcon, Archive as TrashIcon, Info, FileDown, Move as MoveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import useFile from "../hooks/useFile.ts";
import { setArchiveState } from "../utils/archiveState.ts";
import { useSyncStore } from "../store/syncStore.ts";
import { fileStore } from "../store/fileStore.ts";
import translations from "../utils/dictionary.ts";
import { notification } from "../utils/helpers.ts";
import type { Component } from "../utils/types.ts";
import { useShallow } from "zustand/react/shallow";
import Modal from "./Modal.tsx";
import ModalInfo from "./ModalInfo.tsx";
import MoveItemDialog from "./MoveItemDialog.tsx";
import ContextMenu, { MenuItem, MenuSeparator } from "./ContextMenu.tsx";
import { logger } from "../utils/logger.ts";
import { displayNoteLabel, displayNoteName, editableNoteBaseName } from "../utils/visibleNames.ts";
import { commitVisibleName, resolveRenamedNotePhysicalPath, validateVisibleEntryName } from "../utils/visibleNameOps.ts";
import { getFileBaseName } from "../utils/noteName.ts";

function MenuFile({ fileName }: Props): Component {
  const d = translations(),
    { files: filesArr, editedFile } = fileStore(
      useShallow(state => ({ files: state.files, editedFile: state.editedFile }))
    ),
    files: string[] = filesArr,
    { renameFile, readFile } = useFile(),
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

  function handleEditConfirm(value?: string): void {
    if (value === undefined || value === null) return notification("error", d.InvalidName);
    const validation = validateVisibleEntryName(value, "file");
    if (!validation.ok) return notification("error", validation.reason ?? d.InvalidName);

    const physicalBase = getFileBaseName(fileName);
    const lower = physicalBase.toLowerCase();
    const hiddenExt = [".txt", ".md"].find(ext => lower.endsWith(ext));
    // Para extensiones ocultas el campo muestra el título sin extensión; para técnicas muestra el nombre completo.
    // Preservar la extensión física del archivo (no cambiar formato accidentalmente).
    let visibleInput = value;
    if (hiddenExt) {
      // si el usuario no incluyó la extensión oculta, añadirla para conservarla
      if (!visibleInput.toLowerCase().endsWith(hiddenExt)) {
        visibleInput = `${visibleInput}${physicalBase.slice(-hiddenExt.length)}`;
      }
    } else {
      // extensión técnica: preservar la extensión física original
      const dot = physicalBase.lastIndexOf(".");
      const physExt = dot > 0 ? physicalBase.slice(dot) : "";
      if (physExt && !visibleInput.toLowerCase().endsWith(physExt.toLowerCase())) {
        // si el usuario cambió/quitó la extensión, forzar la extensión física original
        const vLower = visibleInput.toLowerCase();
        const vDot = vLower.lastIndexOf(".");
        const vStem = vDot > 0 ? visibleInput.slice(0, vDot) : visibleInput;
        visibleInput = `${vStem}${physExt}`;
      }
    }

    const { physicalPath: nextPhysicalPath, visibleSegment } = resolveRenamedNotePhysicalPath(visibleInput, fileName);

    if (nextPhysicalPath === fileName) {
      // Solo cambia el nombre visible (metadatos), sin operación física.
      commitVisibleName(fileName, "file", visibleSegment);
      setIsEditOpen(false);
      return;
    }

    if (files.includes(nextPhysicalPath)) {
      notification("error", `${displayNoteLabel(nextPhysicalPath)} ya existe`);
      return;
    }

    setIsEditOpen(false);
    renameFile(fileName, nextPhysicalPath)
      .then(() => {
        commitVisibleName(nextPhysicalPath, "file", visibleSegment);
      })
      .catch(() => notification("error", `No se pudo renombrar ${displayNoteLabel(fileName)}`));
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
      notification("error", `No se pudo archivar ${displayNoteLabel(archivedName)}`);
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
        initialValue={editableNoteBaseName(fileName)}
        confirmText={d.Change}
        cancelText={d.Cancel}
      />

      <Modal
        isOpen={isTrashOpen}
        onClose={() => { if (!isArchiving) setIsTrashOpen(false); }}
        onConfirm={handleTrashConfirm}
        title={d.MoveToTrash}
        description={`"${displayNoteName(fileName)}"`}
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
