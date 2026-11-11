import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Calendar, FilePlus, FileText, FolderPlus, HardDrive, Info, Move as MoveIcon, Pencil, RotateCcw } from "lucide-react";
import { fileStore } from "../store/fileStore.ts";
import { getFileBaseName, getFileDirectory } from "../utils/noteName.ts";
import { moveLocalPath } from "../utils/pathOperations.ts";
import { flushActiveEditors } from "../utils/editorPersistence.ts";
import { notification } from "../utils/helpers.ts";
import translations from "../utils/dictionary.ts";
import ContextMenu, { MenuItem, MenuSeparator } from "./ContextMenu.tsx";
import Modal from "./Modal.tsx";
import MoveItemDialog from "./MoveItemDialog.tsx";
import InfoModal, { InfoRow } from "./InfoModal.tsx";

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

type DialogMode = "create" | "rename" | "move" | "archive" | "restore" | "info" | null;

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
  const [mode, setMode] = useState<DialogMode>(null);
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const isRoot = path === "";
  const folderName = isRoot ? "Lyra" : getFileBaseName(path);
  const canManage = !isRoot && !archived && !structural;
  const canCreate = !archived && !structural;

  async function createFolder(parent: string, folderNameToCreate: string): Promise<string> {
    const sanitized = folderNameToCreate.trim();
    if (!sanitized || sanitized !== folderNameToCreate || folderNameToCreate.includes("/") || folderNameToCreate.includes("\\")) {
      throw new Error("Nombre de carpeta inválido");
    }
    const relativePath = parent ? `${parent}/${sanitized}` : sanitized;
    await invoke("create_folder", { relativePath });
    fileStore.getState().setFolders([...fileStore.getState().folders, relativePath]);
    return relativePath;
  }

  function handleCreateConfirm(value?: string): void {
    const requested = value ?? "";
    if (!requested.trim() || requested !== requested.trim() || requested.includes("/") || requested.includes("\\")) {
      return notification("error", d.InvalidName);
    }
    setBusy(true);
    void createFolder(path, requested)
      .then(() => setMode(null))
      .catch(error => notification("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  }

  function handleRenameConfirm(value?: string): void {
    const requested = value ?? "";
    if (!requested.trim() || requested !== requested.trim() || requested.includes("/") || requested.includes("\\")) {
      return notification("error", d.InvalidName);
    }
    const parent = getFileDirectory(path);
    const target = parent ? `${parent}/${requested}` : requested;
    if (target === path) {
      setMode(null);
      return;
    }
    setMode(null);
    void moveLocalPath("folder", path, target)
      .then(warnings => { warnings.forEach(warning => notification("error", warning)); })
      .catch(error => notification("error", error instanceof Error ? error.message : String(error)));
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
      const paths = await invoke<string[]>("set_folder_archived", { relativePath: path, archived: next });
      fileStore.getState().setArchivedFolders(paths);
      const selected = fileStore.getState().selectedFile;
      if (next && selected.name.startsWith(`${path}/`)) fileStore.getState().setSelectedFile({ name: "", content: "" });
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
          label="Crear archivo"
          onSelect={() => {
            window.dispatchEvent(new CustomEvent("lyra:create-note-in-folder", { detail: path }));
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={FolderPlus}
          label="Crear subcarpeta"
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
      title={`Crear subcarpeta en ${folderName}`}
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
      name={info.name}
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
  </div>;
}
