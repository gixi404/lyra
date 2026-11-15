import { useEffect, useMemo, useRef, useState } from "react";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { buildFolderTree, type FolderOrder } from "../utils/folderTree";
import { themes } from "../utils/helpers";
import FolderSelect from "./FolderSelect";

function readFolderOrder(): FolderOrder {
  try {
    const raw = window.localStorage.getItem("folderOrder");
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FolderOrder) : {};
  } catch {
    return {};
  }
}

function flattenFolderPaths(node: { folders: Array<{ path: string; folders: unknown[] }> }): string[] {
  const paths: string[] = [];
  for (const child of node.folders as Array<{ path: string; folders: Array<{ path: string; folders: unknown[] }> }>) {
    paths.push(child.path);
    paths.push(...flattenFolderPaths(child));
  }
  return paths;
}

export default function FolderPicker({ folders, value, onChange, onCreateFolder, excluded = [], label = "Carpeta de destino" }: {
  folders: string[];
  value: string;
  onChange: (path: string) => void;
  onCreateFolder: (parent: string, name: string) => Promise<string>;
  excluded?: string[];
  label?: string;
}): JSX.Element {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isDay } = themes();
  const archivedFolders = fileStore(state => state.archivedFolders);
  const prefTick = configStore(state => state.prefTick);
  const available = folders.filter(path =>
    !excluded.some(item => path === item || path.startsWith(`${item}/`))
    && !archivedFolders.some(item => path === item || path.startsWith(`${item}/`)));
  // Mantener el mismo orden visual que el explorador (respeta folderOrder manual y orden de árbol).
  const orderedAvailable = useMemo(() => {
    const availableSet = new Set(available);
    if (availableSet.size === 0) return [];
    const order = readFolderOrder();
    // Construir árbol con todas las carpetas conocidas para preservar el orden relativo ($top/hijos).
    const tree = buildFolderTree(folders, [], order);
    const ordered = flattenFolderPaths(tree).filter(path => availableSet.has(path));
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

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const path = await onCreateFolder(value, name.trim());
      onChange(path);
      setName("");
      setCreating(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {label ? <label className="block text-sm">{label}</label> : null}
      <FolderSelect
        folders={orderedAvailable}
        value={value}
        onChange={onChange}
        onNewFolder={() => setCreating(true)}
      />
      {creating && (
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Nueva carpeta"
            aria-label="Nombre de la nueva carpeta"
            className={`min-w-0 flex-1 rounded-lg border p-2 ${
              isDay
                ? "border-neutral-300 bg-white text-neutral-900"
                : "border-zinc-500 bg-zinc-900 text-zinc-100"
            }`}
            onKeyDown={event => { if (event.key === "Enter") void create(); if (event.key === "Escape") setCreating(false); }}
          />
          <button type="button" disabled={busy || !name.trim()} onClick={() => void create()}
            className={`rounded-lg px-3 text-sm disabled:opacity-50 ${isDay ? "bg-accent text-ink" : "bg-zinc-700"}`}>Crear</button>
          <button type="button" onClick={() => setCreating(false)} className={`rounded-lg px-2 text-sm ${isDay ? "text-neutral-600 hover:bg-neutral-100" : ""}`}>Cancelar</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
