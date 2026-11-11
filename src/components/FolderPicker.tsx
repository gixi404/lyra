import { useEffect, useRef, useState } from "react";
import { fileStore } from "../store/fileStore";
import { themes } from "../utils/helpers";
import FolderSelect from "./FolderSelect";

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
  const available = folders.filter(path =>
    !excluded.some(item => path === item || path.startsWith(`${item}/`))
    && !archivedFolders.some(item => path === item || path.startsWith(`${item}/`)));

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
        folders={available}
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
