import { Archive, AlertTriangle, CheckCircle2, FileWarning, FolderOpen, ShieldAlert } from "lucide-react";
import { themes } from "../utils/helpers";
import {
  itemActions,
  statusLabel,
  type ItemAction,
  type RetireAction,
  type WorkspaceSnapshot,
} from "../utils/workspaceState";

interface Props {
  snapshot: WorkspaceSnapshot;
  busy: boolean;
  onItemAction: (name: string, action: ItemAction) => void;
  onImport: (name: string) => void;
  onDefer: (name: string) => void;
  onRetireAction: (name: string, action: RetireAction) => void;
  /** Full-screen mode shows progress and where the originals were kept. */
  full?: boolean;
}

const RETIRE_REASONS: Record<string, string> = {
  source_changed: "La nota original cambió después de copiarse",
  destination_missing: "La copia en el espacio de trabajo ya no existe",
  retire_failed: "No se pudo mover la nota original",
};

function MigrationDetails({
  snapshot,
  busy,
  onItemAction,
  onImport,
  onDefer,
  onRetireAction,
  full = false,
}: Props): JSX.Element {
  const { isDay } = themes();
  const muted = isDay ? "text-neutral-600" : "text-zinc-400";
  const card = isDay
    ? "bg-white/90 border-neutral-200 text-neutral-900"
    : "bg-zinc-900/90 border-zinc-800 text-zinc-100";
  const softCard = isDay
    ? "border-neutral-200 bg-neutral-50 text-neutral-700"
    : "border-zinc-800 bg-zinc-800/60 text-zinc-300";

  const total = snapshot.items.length;
  const settled = snapshot.items.filter(item =>
    item.status === "copied" || item.status === "deferred" || item.status === "source_symlink"
  ).length;
  const decisions = snapshot.items.filter(item => itemActions(item.status).length > 0);

  const primaryClass = `inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    isDay
      ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm shadow-indigo-600/20"
      : "bg-sky-500 hover:bg-sky-400 text-zinc-950 font-semibold shadow-sm shadow-sky-500/20"
  }`;
  const secondaryClass = `inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    isDay
      ? "text-neutral-600 hover:bg-neutral-100 border border-neutral-200"
      : "text-zinc-300 hover:bg-zinc-800 border border-zinc-700"
  }`;

  return (
    <div className="flex flex-col gap-4 w-full">
      {full && total > 0 && (
        <section className={`rounded-2xl border p-4 ${card}`} aria-label="Progreso de la migración">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">Notas preparadas</span>
            <span className={muted}>
              {settled} de {total}
            </span>
          </div>
          <div className={`mt-2 h-1.5 w-full overflow-hidden rounded-full ${isDay ? "bg-neutral-200" : "bg-zinc-800"}`}>
            <div
              className={isDay ? "h-full bg-indigo-600" : "h-full bg-sky-500"}
              style={{ width: `${total === 0 ? 0 : Math.round((settled / total) * 100)}%` }}
            />
          </div>
          <p className={`mt-2 text-xs ${muted}`}>
            Nada se sobrescribe: si dos notas comparten nombre, decides cuál conservar y la otra se
            guarda sin cambios.
          </p>
        </section>
      )}

      {decisions.length > 0 && (
        <section className={`rounded-2xl border p-4 ${card}`} aria-label="Notas que necesitan una decisión">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileWarning className="w-4 h-4 shrink-0" aria-hidden="true" />
            Notas que necesitan una decisión
          </h2>
          <ul className="mt-3 space-y-3">
            {decisions.map(item => (
              <li key={item.name} className={`rounded-xl border p-3 ${softCard}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-medium break-all">{item.name}</span>
                  <span className="text-[11px] uppercase tracking-wide">{statusLabel(item.status)}</span>
                </div>
                {item.status === "destination_conflict" && (
                  <p className={`mt-1 text-xs ${muted}`}>
                    Ya existe «{item.destName}» en el espacio de trabajo con otro contenido. No se
                    sobrescribe.
                  </p>
                )}
                {item.detail && <p className={`mt-1 text-xs ${muted}`}>{item.detail}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {itemActions(item.status).map(option => (
                    <button
                      key={option.action}
                      type="button"
                      disabled={busy}
                      onClick={() => onItemAction(item.name, option.action)}
                      className={option.primary ? primaryClass : secondaryClass}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot.strays.length > 0 && (
        <section className={`rounded-2xl border p-4 ${card}`} aria-label="Notas pendientes en la carpeta principal">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FolderOpen className="w-4 h-4 shrink-0" aria-hidden="true" />
            Notas pendientes de importar
          </h2>
          <p className={`mt-1 text-xs ${muted}`}>
            Siguen intactas en Documentos/lyra. No cuentan como migradas hasta que las importes o las
            dejes pendientes a propósito.
          </p>
          <ul className="mt-3 space-y-3">
            {snapshot.strays.map(stray => (
              <li key={stray.name} className={`rounded-xl border p-3 ${softCard}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-medium break-all">{stray.name}</span>
                  {stray.deferred && (
                    <span className="text-[11px] uppercase tracking-wide">Aplazada</span>
                  )}
                </div>
                {stray.detail && <p className={`mt-1 text-xs ${muted}`}>{stray.detail}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {stray.importable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onImport(stray.name)}
                      className={primaryClass}
                    >
                      Importar al espacio
                    </button>
                  )}
                  {!stray.deferred && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDefer(stray.name)}
                      className={secondaryClass}
                    >
                      Dejar pendiente
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot.retireConflicts.length > 0 && (
        <section className={`rounded-2xl border p-4 ${card}`} aria-label="Conflictos al guardar las originales">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Archive className="w-4 h-4 shrink-0" aria-hidden="true" />
            Originales que no se pudieron guardar
          </h2>
          <p className={`mt-1 text-xs ${muted}`}>
            La nota original sigue donde estaba. Nada se ha borrado; solo falta decidir qué hacer con
            ella.
          </p>
          <ul className="mt-3 space-y-3">
            {snapshot.retireConflicts.map(conflict => (
              <li key={conflict.name} className={`rounded-xl border p-3 ${softCard}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-medium break-all">{conflict.name}</span>
                  <span className="text-[11px] uppercase tracking-wide">
                    {RETIRE_REASONS[conflict.reason] ?? "Conflicto al guardar la original"}
                  </span>
                </div>
                {conflict.detail && <p className={`mt-1 text-xs ${muted}`}>{conflict.detail}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRetireAction(conflict.name, "keep_as_pending")}
                    className={primaryClass}
                  >
                    Dejarla pendiente
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRetireAction(conflict.name, "move_to_rescatados")}
                    className={secondaryClass}
                  >
                    Mover a rescatados
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot.workspace && (snapshot.workspace.writePolicy === "read_only" || snapshot.workspace.status !== "ready") && (
        <section
          role="status"
          className={`rounded-2xl border p-4 ${softCard}`}
          aria-label="Espacio de trabajo de solo lectura"
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            Espacio de solo lectura
          </h2>
          <p className="mt-1 text-xs">
            {snapshot.workspace.linkageLost
              ? "Se perdió el vínculo con la cuenta de Google de este espacio. Puedes leer tus notas, pero no editarlas hasta reconectar la cuenta."
              : "Las notas se pueden leer, pero este espacio no admite cambios ahora mismo."}
          </p>
        </section>
      )}

      {full && snapshot.restoreDir && (
        <p className={`flex items-start gap-2 text-xs ${muted}`}>
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Tus notas originales se conservan en Documentos/{snapshot.restoreDir}. Puedes volver a
            ellas cuando quieras.
          </span>
        </p>
      )}

      {snapshot.drivePaused && full && (
        <p className={`flex items-start gap-2 text-xs ${muted}`}>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            La sincronización con Google Drive está en pausa mientras se completan los espacios de
            trabajo. Tus notas no se envían ni se descargan hasta que se reactive.
          </span>
        </p>
      )}
    </div>
  );
}

export default MigrationDetails;
