import { useState } from "react";
import type { WorkspaceInfo, WorkspaceKind } from "../utils/workspaceState";

interface Props {
  activeId: string;
  workspaces: WorkspaceInfo[];
  busy: boolean;
  error: string | null;
  onCreate: (name: string, kind: WorkspaceKind) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onSelect: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

export default function WorkspaceSelector({ activeId, workspaces, busy, error, onCreate, onRename, onSelect, onDelete }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<WorkspaceKind>("local");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const active = workspaces.find(workspace => workspace.id === activeId);

  return (
    <div className="no-print fixed top-3 left-1/2 -translate-x-1/2 z-[80] text-sm">
      <button type="button" disabled={busy} aria-expanded={open} aria-label="Seleccionar espacio de trabajo"
        onClick={() => setOpen(value => !value)}
        className="rounded-xl border border-zinc-500/40 bg-zinc-900 px-3 py-2 text-zinc-100 shadow-lg disabled:opacity-60">
        {active?.name ?? "Espacio de trabajo"} ▾
      </button>
      {open && <div className="absolute left-1/2 top-11 w-[min(92vw,360px)] -translate-x-1/2 rounded-2xl border border-zinc-600/50 bg-zinc-900 p-3 text-zinc-100 shadow-2xl">
        <h2 className="mb-2 font-semibold">Espacios de trabajo</h2>
        <ul className="max-h-60 space-y-2 overflow-y-auto">
          {workspaces.map(workspace => <li key={workspace.id} className="rounded-lg border border-zinc-700 p-2">
            {renaming === workspace.id ? <form onSubmit={event => { event.preventDefault(); void onRename(workspace.id, renameValue).then(ok => { if (ok) setRenaming(null); }); }} className="flex gap-2">
              <input value={renameValue} onChange={event => setRenameValue(event.target.value)} maxLength={60} autoFocus
                aria-label={`Nuevo nombre de ${workspace.name}`} className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1" />
              <button disabled={busy} type="submit">Guardar</button>
            </form> : <div className="flex items-center justify-between gap-2">
              <button type="button" disabled={busy || workspace.id === activeId || workspace.status !== "ready"}
                onClick={() => { void onSelect(workspace.id).then(ok => { if (ok) setOpen(false); }); }}
                className="truncate text-left disabled:opacity-60" title={workspace.status === "ready" ? workspace.name : "El espacio necesita reparación"}>
                {workspace.name}{workspace.id === activeId ? " (actual)" : ""}
              </button>
              <div className="flex shrink-0 gap-2 text-xs text-sky-300">
                <button type="button" disabled={busy || workspace.status !== "ready"}
                  onClick={() => { setRenaming(workspace.id); setRenameValue(workspace.name); setConfirmDelete(null); }}>Renombrar</button>
                <button type="button" disabled={busy || workspace.id === activeId || workspaces.length <= 1 || workspace.status !== "ready"}
                  onClick={() => { setConfirmDelete(workspace.id); setRenaming(null); }}>Eliminar</button>
              </div>
            </div>}
            {confirmDelete === workspace.id && <div className="mt-2 rounded bg-amber-950/60 p-2 text-xs">
              <p>El espacio y todas sus notas se conservarán en rescatados. Esta acción lo quitará del selector.</p>
              <div className="mt-2 flex gap-3">
                <button type="button" disabled={busy} onClick={() => { void onDelete(workspace.id).then(ok => { if (ok) setConfirmDelete(null); }); }} className="font-semibold text-amber-200">Confirmar eliminación</button>
                <button type="button" onClick={() => setConfirmDelete(null)}>Cancelar</button>
              </div>
            </div>}
          </li>)}
        </ul>
        <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void onCreate(newName, newKind).then(ok => { if (ok) setNewName(""); }); }}>
          <input value={newName} onChange={event => setNewName(event.target.value)} maxLength={60} placeholder="Nuevo espacio" aria-label="Nombre del nuevo espacio"
            disabled={busy || workspaces.length >= 5} className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1" />
          <select value={newKind} onChange={event => setNewKind(event.target.value as WorkspaceKind)}
            aria-label="Tipo de espacio" disabled={busy || workspaces.length >= 5} className="rounded bg-zinc-800 px-2 py-1">
            <option value="local">Local</option>
            <option value="google_drive">Google Drive</option>
          </select>
          <button disabled={busy || workspaces.length >= 5 || !newName.trim()} type="submit" className="text-sky-300">Crear</button>
        </form>
        <p className="mt-1 text-xs text-zinc-400">{workspaces.length} de 5 espacios</p>
        {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
      </div>}
    </div>
  );
}
