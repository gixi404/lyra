import { ArrowUpLeft as RecoveryIcon, Trash as RemoveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import useFile from "../hooks/useFile.ts";
import useStorage from "../hooks/useStorage.ts";
import { fileStore } from "../store/fileStore.ts";
import translations from "../utils/dictionary.ts";
import { navigation, notification } from "../utils/helpers.ts";
import { isWelcomeFileName, setWelcomeManuallyRestored } from "../utils/welcome.ts";
import { setArchiveState, refreshArchiveState } from "../utils/archiveState.ts";
import { useSyncStore } from "../store/syncStore.ts";
import { GDRIVE_REMOTE_SYNC_ENABLED } from "../utils/gdriveRemote.ts";
import type { Component } from "../utils/types.ts";
import { useShallow } from "zustand/react/shallow";
import Modal from "./Modal.tsx";
import MoveItemDialog from "./MoveItemDialog.tsx";
import ContextMenu, { MenuItem, MenuSeparator } from "./ContextMenu.tsx";
import { runExclusiveDeletion } from "../utils/noteDeletion.ts";
import { displayNoteLabel, displayNoteName, displayNoteSuccessMessage } from "../utils/visibleNames.ts";
import { PAGES } from "../utils/consts.ts";
import { logger } from "../utils/logger.ts";

function MenuPaperFile({ fileName, individuallyArchived = true, archivedByFolder = false, needsRecoveryDestination = false }: Props): Component {
  const d = translations(),
    { getItem } = useStorage(),
    { deleteFile } = useFile(),
    { editedFile, removeFileFromList } = fileStore(
      useShallow(state => ({
        editedFile: state.editedFile,
        removeFileFromList: state.removeFileFromList,
      }))
    ),
    { goTo } = navigation(),
    [isRestoreOpen, setIsRestoreOpen] = useState<boolean>(false),
    [isRestoreMoveOpen, setIsRestoreMoveOpen] = useState<boolean>(false),
    [isRestoring, setIsRestoring] = useState<boolean>(false),
    restoringRef = useRef(false),
    [isDeleteOpen, setIsDeleteOpen] = useState<boolean>(false),
    isDeleting = fileStore(state => state.deletingFiles.includes(fileName)),
    isEmptyingArchived = fileStore(state => state.isEmptyingArchived),
    deletionBusy = isDeleting || isEmptyingArchived,
    mountedRef = useRef(false);

  void archivedByFolder;
  void individuallyArchived;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function handleRestoreConfirm(): Promise<void> {
    if (restoringRef.current) return;
    if (needsRecoveryDestination) {
      setIsRestoreOpen(false);
      setIsRestoreMoveOpen(true);
      return;
    }
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
      if (GDRIVE_REMOTE_SYNC_ENABLED && useSyncStore.getState().isConnected && navigator.onLine) {
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

  function onRecoveredToActive(): void {
    void (async () => {
      try {
        await refreshArchiveState();
      } catch { /* best effort */ }
      editedFile();
      goTo(PAGES.list);
    })();
  }

  return (
    <div className="relative flex items-center">
      <ContextMenu label="Opciones" title="Opciones" reveal="hover">
        <MenuItem
          icon={RecoveryIcon}
          label={d.Recover ?? "Recuperar"}
          tone="success"
          onSelect={() => {
            if (needsRecoveryDestination) setIsRestoreMoveOpen(true);
            else setIsRestoreOpen(true);
          }}
        />

        <MenuSeparator />

        <MenuItem
          icon={RemoveIcon}
          label={d.Delete ?? "Eliminar"}
          tone="danger"
          onSelect={() => setIsDeleteOpen(true)}
        />
      </ContextMenu>

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

      <MoveItemDialog
        isOpen={isRestoreMoveOpen}
        kind="file"
        itemName={fileName}
        onClose={() => setIsRestoreMoveOpen(false)}
        recovery
        onCompleted={() => onRecoveredToActive()}
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
  needsRecoveryDestination?: boolean;
}
