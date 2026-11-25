import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Calendar, FilePlus, FileText, FolderPlus, HardDrive, Info, Move as MoveIcon, Paintbrush, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { fileStore } from "../store/fileStore.ts";
import useStorage from "../hooks/useStorage.ts";
import { expandParentPath, readFolderExpandedState } from "../utils/folderTree.ts";
import { getFileDirectory } from "../utils/noteName.ts";
import { displayFolderName } from "../utils/visibleNames.ts";
import { formatDisplayDateTime } from "../utils/formatDate.ts";
import { moveLocalPath } from "../utils/pathOperations.ts";
import { savePersistentPreferencesNow } from "../utils/persistentPreferences.ts";
import { flushActiveEditors } from "../utils/editorPersistence.ts";
import { navigation, notification } from "../utils/helpers.ts";
import { commitVisibleName, resolveNewFolderPhysicalPath, resolveRenamedFolderPhysicalPath, validateVisibleEntryName } from "../utils/visibleNameOps.ts";
import { PAGES } from "../utils/consts.ts";
import translations from "../utils/dictionary.ts";
import ContextMenu, { MenuItem, MenuSeparator } from "./ContextMenu.tsx";
import Modal from "./Modal.tsx";
import MoveItemDialog from "./MoveItemDialog.tsx";
import InfoModal, { InfoRow } from "./InfoModal.tsx";
import FolderAppearanceDialog from "./FolderAppearanceDialog.tsx";
import { hasArchivedAncestor, type ArchivedFolderKind } from "../utils/archivePathState.ts";
import { cleanupAfterDeletedPaths } from "../utils/deletedPathCleanup.ts";
import { refreshArchiveState } from "../utils/archiveState.ts";

interface FolderInfo {
  name: string;
  location: string;
  directFiles: number;
  totalFiles: number;
  directFolders: number;
  totalFolders: number;
  totalBytes: number;
  createdAt: number | null;
  modifiedAt: number | null;
  scopeFingerprint?: string;
}

interface DeleteFolderResult {
  deletedFiles: string[];
  deletedFolders: string[];
  counts: { directFiles: number; totalFiles: number; directFolders: number; totalFolders: number };
}

type DialogMode = "create" | "rename" | "move" | "archive" | "restore" | "restoreMove" | "delete" | "info" | "personalize" | null;

export default function FolderMenu({ path, archived = false, structural = false, folderArchiveKind = archived ? "explicit" : "active" }: {
  path: string;
  archived?: boolean;
  structural?: boolean;
  folderArchiveKind?: ArchivedFolderKind | "active";
}) {
  const d = translations();
  const { setItem } = useStorage();
  const { goTo } = navigation();
  const [mode, setMode] = useState<DialogMode>(null);
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [deleteCounts, setDeleteCounts] = useState<FolderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const isRoot = path === "";
  const folderName = displayFolderName(path);
  const archivedFolders = fileStore(state => state.archivedFolders);
  const isArchivedItem = !structural && archived && folderArchiveKind !== "active";
  const needsRecoveryDestination = isArchivedItem && hasArchivedAncestor(path, archivedFolders);
  const canRename = !archived && !structural;
  const canPersonalize = !archived && !structural;
  const canMove = !isRoot && !archived && !structural;
  const canArchive = !isRoot && !archived && !structural;
  const canCreate = !archived && !structural;

  async function createFolder(parent: string, folderNameToCreate: string): Promise<string> {
    const validation = validateVisibleEntryName(folderNameToCreate, "folder");
    if (!validation.ok) throw new Error(validation.reason ?? d.InvalidName);
    const { physicalPath, visibleSegment } = resolveNewFolderPhysicalPath(folderNameToCreate, parent);
    await invoke("create_folder", { relativePath: physicalPath });
    fileStore.getState().setFolders([...fileStore.getState().folders, physicalPath]);
    commitVisibleName(physicalPath, "folder", visibleSegment);
    if (parent) {
      const nextExpanded = expandParentPath(readFolderExpandedState(window.localStorage), parent);
      setItem("folderExpanded", JSON.stringify(nextExpanded));
    }
    return physicalPath;
  }

  function handleCreateConfirm(value?: string): void {
    const requested = value ?? "";
    const validation = validateVisibleEntryName(requested, "folder");
    if (!validation.ok) {
      return notification("error", validation.reason ?? d.InvalidName);
    }
    setBusy(true);
    void createFolder(path, requested)
      .then(() => setMode(null))
      .catch(error => notification("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  }

  function handleRenameConfirm(value?: string): void {
    if (busy) return;
    const requested = value ?? "";
    const validation = validateVisibleEntryName(requested, "folder");
    if (!validation.ok) {
      return notification("error", validation.reason ?? d.InvalidName);
    }
    if (isRoot) {
      commitVisibleName(path, "folder", requested.trim());
      setMode(null);
      return;
    }
    const { physicalPath: target, visibleSegment } = resolveRenamedFolderPhysicalPath(requested, path);
    if (target === path) {
      commitVisibleName(path, "folder", visibleSegment);
      setMode(null);
      return;
    }
    setBusy(true);
    void moveLocalPath("folder", path, target)
      .then(warnings => {
        warnings.forEach(warning => notification("error", warning));
        commitVisibleName(target, "folder", visibleSegment);
        setMode(null);
      })
      .catch(error => notification("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  }

  async function setArchived(next: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await flushActiveEditors())) {
        notification("error", "No se pudo guardar la nota abierta");
        setMode(null);
        return;
      }
      const selectedBefore = fileStore.getState().selectedFile.name;
      const paths = await invoke<string[]>("set_folder_archived", { relativePath: path, archived: next });
      fileStore.setState(state => ({
        archivedFolders: paths,
        folderArchiveError: null,
        folderArchiveLoaded: true,
        listingGeneration: state.listingGeneration + 1,
      }));

      if (next && selectedBefore && (selectedBefore === path || selectedBefore.startsWith(`${path}/`))) {
        fileStore.getState().setSelectedFile({ name: "", content: "" });
        goTo(PAGES.list);
      }

      if (!next) {
        const effectivelyActive = !paths.some(archivedPath => path === archivedPath || path.startsWith(`${archivedPath}/`));
        if (effectivelyActive) {
          const parentPath = getFileDirectory(path);
          const currentExpanded = readFolderExpandedState(window.localStorage);
          const nextExpanded = parentPath ? expandParentPath(currentExpanded, parentPath) : currentExpanded;
          if (nextExpanded !== currentExpanded) {
            setItem("folderExpanded", JSON.stringify(nextExpanded));
            try {
              await savePersistentPreferencesNow();
            } catch {
              notification("error", "La carpeta se recuperó, pero no se pudo guardar la expansión del explorador.");
            }
          }
        }
      }

      setMode(null);
    } catch (error) {
      notification("error", error instanceof Error ? error.message : String(error));
      setMode(null);
    } finally {
      setBusy(false);
    }
  }

  async function showInfo(): Promise<void> {
    try {
      const result = await invoke<FolderInfo>("folder_info", { relativePath: path });
      setInfo(result);
      setMode("info");
    } catch (error) {
      notification("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function prepareDelete(): Promise<void> {
    try {
      const result = await invoke<FolderInfo>("folder_info", { relativePath: path });
      setDeleteCounts(result);
      setMode("delete");
    } catch (error) {
      notification("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await flushActiveEditors())) {
        notification("error", "No se pudo guardar la nota abierta");
        return;
      }
      const expected = deleteCounts
        ? { totalFiles: deleteCounts.totalFiles, totalFolders: deleteCounts.totalFolders, scopeFingerprint: deleteCounts.scopeFingerprint ?? "" }
        : null;
      const result = await invoke<DeleteFolderResult>("delete_archived_folder_permanently", { relativePath: path, expected });
      cleanupAfterDeletedPaths(result.deletedFolders, result.deletedFiles);
      try {
        await refreshArchiveState();
      } catch { /* best effort */ }
      const selected = fileStore.getState().selectedFile.name;
      if (selected && (result.deletedFiles.includes(selected) || result.deletedFolders.some(f => selected === f || selected.startsWith(`${f}/`)))) {
        fileStore.getState().setSelectedFile({ name: "", content: "" });
        goTo(PAGES.list);
      }
      fileStore.setState(state => ({
        folders: state.folders.filter(f => !result.deletedFolders.includes(f)),
        files: state.files.filter(f => !result.deletedFiles.includes(f)),
        archivedFolders: state.archivedFolders.filter(f => !result.deletedFolders.includes(f)),
        listingGeneration: state.listingGeneration + 1,
      }));
      setMode(null);
      notification("success", "Carpeta eliminada permanentemente");
    } catch (error) {
      onRecovered();
      notification("error", `No se pudo completar la eliminación: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function onRecovered(): void {
    void (async () => {
      try {
        const paths = await invoke<string[]>("list_archived_folders");
        fileStore.setState(state => ({
          archivedFolders: paths,
          folderArchiveError: null,
          folderArchiveLoaded: true,
          listingGeneration: state.listingGeneration + 1,
        }));
      } catch {
        fileStore.setState(state => ({ listingGeneration: state.listingGeneration + 1 }));
      }
      try {
        await refreshArchiveState();
      } catch { /* best effort */ }
    })();
  }

  const showInfoAction = !archived && !structural;
  const hasActionsAfterInfo = canCreate || canRename || canPersonalize || canMove || canArchive || isArchivedItem;

  return <div className="relative ml-auto" onClick={event => event.stopPropagation()}>
    <ContextMenu label={`Opciones de ${folderName}`} title={`Opciones de ${folderName}`}>
      {showInfoAction && (
        <>
          <MenuItem icon={Info} label="Información" onSelect={() => void showInfo()} />
          {hasActionsAfterInfo && <MenuSeparator />}
        </>
      )}

      {canCreate && <>
        <MenuItem
          icon={FilePlus}
          label={d.NewNote}
          onSelect={() => {
            window.dispatchEvent(new CustomEvent("lyra:create-note-in-folder", { detail: path }));
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={FolderPlus}
          label={isRoot ? "Nueva carpeta" : "Nueva subcarpeta"}
          onSelect={() => { setMode("create"); }}
        />
        <MenuSeparator />
      </>}

      {canRename && <>
        <MenuItem icon={Pencil} label="Renombrar" onSelect={() => { setMode("rename"); }} />
        <MenuSeparator />
      </>}

      {canPersonalize && <>
        <MenuItem icon={Paintbrush} label="Personalizar" onSelect={() => { setMode("personalize"); }} />
        {canMove && <MenuSeparator />}
      </>}

      {canMove && <>
        <MenuItem icon={MoveIcon} label="Mover a…" onSelect={() => { setMode("move"); }} />
        <MenuSeparator />
      </>}

      {canArchive && <>
        <MenuItem icon={Archive} label="Archivar" tone="danger" onSelect={() => { setMode("archive"); }} />
      </>}

      {isArchivedItem && (
        <MenuItem
          icon={RotateCcw}
          label="Recuperar"
          onSelect={() => {
            if (needsRecoveryDestination) setMode("restoreMove");
            else setMode("restore");
          }}
        />
      )}

      {isArchivedItem && (
        <>
          <MenuSeparator />
          <MenuItem icon={Trash2} label="Eliminar" tone="danger" onSelect={() => void prepareDelete()} />
        </>
      )}
    </ContextMenu>

    <Modal
      isOpen={mode === "create"}
      onClose={() => { if (!busy) setMode(null); }}
      onConfirm={handleCreateConfirm}
      title={isRoot ? `Nueva carpeta en ${folderName}` : `Nueva subcarpeta en ${folderName}`}
      hasInput
      initialValue=""
      confirmText={d.Create}
      cancelText={d.Cancel}
      busy={busy}
    />

    <Modal
      isOpen={mode === "rename"}
      onClose={() => { if (!busy) setMode(null); }}
      onConfirm={handleRenameConfirm}
      title={d.RenameFolder}
      hasInput
      initialValue={folderName}
      confirmText={d.Change}
      cancelText={d.Cancel}
      busy={busy}
      autoSelectInput
    />

    <Modal
      isOpen={mode === "archive"}
      onClose={() => { if (!busy) setMode(null); }}
      onConfirm={() => void setArchived(true)}
      title={d.MoveToTrashFolder}
      description={`"${folderName}" — ${d.ArchiveFolderDescription}`}
      confirmText={d.Confirm}
      cancelText={d.Cancel}
      variant="danger"
      busy={busy}
    />

    <Modal
      isOpen={mode === "restore"}
      onClose={() => { if (!busy) setMode(null); }}
      onConfirm={() => void setArchived(false).then(onRecovered)}
      title={d.RestoreFolderQuestion}
      description={`"${folderName}"`}
      confirmText={d.Recover}
      cancelText={d.Cancel}
      busy={busy}
    />

    <MoveItemDialog
      isOpen={mode === "move"}
      kind="folder"
      itemName={path}
      excluded={[path]}
      onClose={() => setMode(null)}
    />

    <MoveItemDialog
      isOpen={mode === "restoreMove"}
      kind="folder"
      itemName={path}
      excluded={[path]}
      recovery
      onClose={() => setMode(null)}
      onCompleted={() => onRecovered()}
    />

    <Modal
      isOpen={mode === "delete"}
      onClose={() => { if (!busy) setMode(null); }}
      onConfirm={() => void handleDeleteConfirm()}
      title="Eliminar carpeta"
      description={deleteCounts ? `Se eliminará permanentemente "${folderName}" con ${deleteCounts.totalFiles} archivo(s) y ${deleteCounts.totalFolders} subcarpeta(s). Esta operación es irreversible.` : `Se eliminará permanentemente "${folderName}". Esta operación es irreversible.`}
      confirmText={d.Delete}
      cancelText={d.Cancel}
      variant="danger"
      busy={busy}
    />

    <InfoModal
      isOpen={mode === "info"}
      onClose={() => setMode(null)}
      title={d.FolderInfoTitle}
      icon={Info}
      name={isRoot ? undefined : folderName}
    >
      {info ? (
        <div className="flex flex-col gap-y-2 text-xs">
          {isRoot && (
            <p className="mb-1 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[11px] leading-relaxed text-sky-700 dark:text-sky-300">
              {`El directorio ${folderName} no puede ser eliminado, ya que contiene los archivos sin asignar`}
            </p>
          )}
          <InfoRow icon={FileText} label="Archivos directos" value={info.directFiles} />
          <InfoRow icon={FileText} label="Archivos totales" value={info.totalFiles} />
          <InfoRow icon={FileText} label="Subcarpetas directas" value={info.directFolders} />
          <InfoRow icon={FileText} label="Subcarpetas totales" value={info.totalFolders} />
          <InfoRow icon={HardDrive} label="Tamaño" value={`${info.totalBytes} B`} />
          <InfoRow icon={Calendar} label="Creada" value={formatDisplayDateTime(info.createdAt)} />
          <InfoRow icon={Calendar} label="Modificada" value={formatDisplayDateTime(info.modifiedAt)} last />
        </div>
      ) : null}
    </InfoModal>

    {canPersonalize && (
      <FolderAppearanceDialog
        isOpen={mode === "personalize"}
        folderPath={path}
        onClose={() => setMode(null)}
      />
    )}
  </div>;
}
