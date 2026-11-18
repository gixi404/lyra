import { useMemo, useState } from "react";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { getOrderedFolderPaths, readFolderOrder } from "../utils/folderTree";
import { themes } from "../utils/helpers";
import FolderSelect from "./FolderSelect";
import Modal from "./Modal";

export default function FolderPicker({ folders, value, onChange, onCreateFolder, excluded = [], excludedExact = [], label = "Carpeta de destino", allowRoot = true }: {
  folders: string[];
  value: string;
  onChange: (path: string) => void;
  onCreateFolder: (parent: string, name: string) => Promise<string>;
  /** Excluye estas rutas y todos sus descendientes. */
  excluded?: string[];
  /** Excluye únicamente estas rutas exactas (no sus descendientes). */
  excludedExact?: string[];
  label?: string;
  allowRoot?: boolean;
}): JSX.Element {
  const { isDay } = themes();
  void isDay;
  // bg-white bg-zinc-
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const archivedFolders = fileStore(state => state.archivedFolders);
  const prefTick = configStore(state => state.prefTick);
  const excludedExactSet = useMemo(() => new Set(excludedExact), [excludedExact]);
  const available = folders.filter(path =>
    !excluded.some(item => path === item || path.startsWith(`${item}/`))
    && !excludedExactSet.has(path)
    && !archivedFolders.some(item => path === item || path.startsWith(`${item}/`)));
  // Mantener el mismo orden visual que el explorador (respeta folderOrder manual y orden de árbol).
  const orderedAvailable = useMemo(() => {
    const availableSet = new Set(available);
    if (availableSet.size === 0) return [];
    const order = readFolderOrder();
    // Construir árbol con todas las carpetas conocidas para preservar el orden relativo ($top/hijos).
    const ordered = getOrderedFolderPaths(folders, order).filter(path => availableSet.has(path));
    // Incluir por seguridad cualquier carpeta disponible ausente en el árbol/orden (fallback estable).
    if (ordered.length !== available.length) {
      const seen = new Set(ordered);
      for (const path of available) {
        if (!seen.has(path)) ordered.push(path);
      }
    }
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-lee folderOrder de localStorage ante cambios de preferencias
  }, [available, folders, prefTick]);

  function openCreate() {
    setError("");
    setCreating(true);
  }

  function closeCreate() {
    if (busy) return;
    setCreating(false);
    setError("");
  }

  async function create(name: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const path = await onCreateFolder(value, name);
      onChange(path);
      setCreating(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const title = value ? "Nueva subcarpeta" : "Nueva carpeta";

  return (
    <div className="space-y-2">
      {label ? <label className="block text-sm">{label}</label> : null}
      <FolderSelect
        folders={orderedAvailable}
        value={value}
        onChange={onChange}
        onNewFolder={openCreate}
        allowRoot={allowRoot}
      />
      <Modal
        isOpen={creating}
        onClose={closeCreate}
        onConfirm={(name) => { if (name) void create(name); }}
        title={title}
        hasInput
        inputPlaceholder="Nombre de la carpeta"
        confirmText="Crear"
        cancelText="Cancelar"
        busy={busy}
        error={error}
      />
    </div>
  );
}
