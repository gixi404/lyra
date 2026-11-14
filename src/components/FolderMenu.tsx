import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Calendar, FilePlus, FileText, FolderPlus, HardDrive, Info, Move as MoveIcon, Paintbrush, Pencil, RotateCcw } from "lucide-react";
import { fileStore } from "../store/fileStore.ts";
import useStorage from "../hooks/useStorage.ts";
import { expandParentPath, readFolderExpandedState } from "../utils/folderTree.ts";
import { getFileDirectory } from "../utils/noteName.ts";
import { displayFolderName } from "../utils/visibleNames.ts";
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
}

type DialogMode = "create" | "rename" | "move" | "archive" | "restore" | "info" | "personalize" | null;

/**
 * Menú contextual de las carpetas.
 * Reutiliza el menú, los diálogos y la ventana de información de los archivos:
 * ambos elementos comparten estilos, transiciones y convenciones de interacción.
 */
export default function FolderMenu({ path, archived = false, structural = false }: {
  path: string;
  archived?: boolean;
  structural?: boolean;
}) {
  const d = translations();
  const { setItem } = useStorage();
  const { goTo } = navigation();
  const [mode, setMode] = useState<DialogMode>(null);
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const isRoot = path === "";
  const folderName = isRoot ? "Lyra" : displayFolderName(path);
  const canManage = !isRoot && !archived && !structural;
  const canCreate = !archived && !structural;

  async function createFolder(parent: string, folderNameToCreate: string): Promise<string> {
    const validation = validateVisibleEntryName(folderNameToCreate, "folder");
    if (!validation.ok) throw new Error(validation.reason ?? d.InvalidName);
    const { physicalPath, visibleSegment } = resolveNewFolderPhysicalPath(folderNameToCreate, parent);
    await invoke("create_folder", { relativePath: physicalPath });
    fileStore.getState().setFolders([...fileStore.getState().folders, physicalPath]);
    // Confirmar metadatos visibles tras la creación física.
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
    const { physicalPath: target, visibleSegment } = resolveRenamedFolderPhysicalPath(requested, path);
    if (target === path) {
      // Nombre físico sin cambios: actualizar solo nombre visible si procede.
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
      // Publicación coherente: actualiza estado y invalida lecturas obsoletas de archivedFolders.
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
              // Recuperación lógica ya confirmada; la expansión visual es preferencia no crítica.
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

  return <div className="relative ml-auto" onClick={event => event.stopPropagation()}>
    <ContextMenu label={`Opciones de ${folderName}`} title={`Opciones de ${folderName}`}>
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

      {canManage && <>
        <MenuItem
          icon={Pencil}
          label="Renombrar"
          onSelect={() => { setMode("rename"); }}
        />
        <MenuSeparator />
        <MenuItem
          icon={Paintbrush}
          label="Personalizar"
          onSelect={() => { setMode("personalize"); }}
        />
        <MenuSeparator />
        <MenuItem
          icon={MoveIcon}
          label="Mover a…"
          onSelect={() => { setMode("move"); }}
        />
        <MenuSeparator />
        <MenuItem
          icon={Archive}
          label="Archivar"
          tone="danger"
          onSelect={() => { setMode("archive"); }}
        />
        <MenuSeparator />
      </>}

      {archived && <>
        <MenuItem
          icon={RotateCcw}
          label="Recuperar"
          onSelect={() => { setMode("restore"); }}
        />
        <MenuSeparator />
      </>}

      <MenuItem
        icon={Info}
        label="Información"
        onSelect={() => void showInfo()}
      />
    </ContextMenu>

    <Modal
      isOpen={mode === "create"}
      onClose={() => { if (!busy) setMode(null); }}
      onConfirm={handleCreateConfirm}
      title={isRoot ? "Nueva carpeta en Lyra" : `Nueva subcarpeta en ${folderName}`}
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
      onConfirm={() => void setArchived(false)}
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

    {mode === "info" && info && <InfoModal
      isOpen={mode === "info"}
      onClose={() => setMode(null)}
      title={d.FolderInfoTitle}
      icon={Info}
      name={folderName}
    >
      <div className="flex flex-col gap-y-2 text-xs">
        <InfoRow icon={FileText} label="Archivos directos" value={info.directFiles} />
        <InfoRow icon={FileText} label="Archivos totales" value={info.totalFiles} />
        <InfoRow icon={FileText} label="Subcarpetas directas" value={info.directFolders} />
        <InfoRow icon={FileText} label="Subcarpetas totales" value={info.totalFolders} />
        <InfoRow icon={HardDrive} label="Tamaño" value={`${info.totalBytes} B`} />
        <InfoRow icon={Calendar} label="Creada" value={info.createdAt ? new Date(info.createdAt).toLocaleString() : "No disponible"} />
        <InfoRow icon={Calendar} label="Modificada" value={info.modifiedAt ? new Date(info.modifiedAt).toLocaleString() : "No disponible"} last />
      </div>
    </InfoModal>}

    {canManage && mode === "personalize" && (
      <FolderAppearanceDialog
        isOpen={mode === "personalize"}
        folderPath={path}
        onClose={() => setMode(null)}
      />
    )}
  </div>;
}
