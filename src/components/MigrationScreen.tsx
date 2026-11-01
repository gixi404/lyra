import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { themes } from "../utils/helpers";
import { phaseLabel, type ItemAction, type RetireAction, type WorkspaceSnapshot } from "../utils/workspaceState";
import MigrationDetails from "./MigrationDetails";

interface Props {
  snapshot: WorkspaceSnapshot;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onItemAction: (name: string, action: ItemAction) => void;
  onImport: (name: string) => void;
  onDefer: (name: string) => void;
  onRetireAction: (name: string, action: RetireAction) => void;
}

/**
 * Full-screen gate shown before the app can start. It never decides on its own
 * that the migration is over: the backend returns `required: false` only when
 * every note is copied or explicitly deferred and no new note blocks the gate.
 */
function MigrationScreen({
  snapshot,
  busy,
  error,
  onRetry,
  onItemAction,
  onImport,
  onDefer,
  onRetireAction,
}: Props): JSX.Element {
  const { isDay } = themes();

  return (
    <div className="min-h-screen w-full flex justify-center px-4 sm:px-6 py-8 sm:py-12">
      <div className="w-full max-w-[720px] flex flex-col gap-5">
        <header>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
              Preparando tu espacio de trabajo
            </h1>
            {busy && (
              <span className={`inline-flex items-center gap-1.5 text-xs ${isDay ? "text-neutral-500" : "text-zinc-400"}`}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Procesando
              </span>
            )}
          </div>
          <p className={`mt-2 text-sm ${isDay ? "text-neutral-600" : "text-zinc-400"}`}>
            {phaseLabel(snapshot.phase)}. Tus notas se mueven a una carpeta de espacio de trabajo y
            los originales se conservan por seguridad. Nada se borra.
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className={`rounded-2xl border p-4 text-sm ${
              isDay
                ? "text-rose-700 border-rose-200 bg-rose-50"
                : "text-rose-300 border-rose-900/60 bg-rose-950/40"
            }`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium">No se pudo completar el último paso</p>
                <p className="mt-1 break-words">{error}</p>
                <p className="mt-1 text-xs opacity-80">
                  Tus notas siguen en su sitio. Puedes reintentar sin perder nada.
                </p>
              </div>
            </div>
          </div>
        )}

        {snapshot.error && !error && (
          <p
            role="status"
            className={`rounded-2xl border p-3 text-xs ${
              isDay
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-amber-900/60 bg-amber-950/40 text-amber-200"
            }`}
          >
            {snapshot.error}
          </p>
        )}

        <MigrationDetails
          snapshot={snapshot}
          busy={busy}
          onItemAction={onItemAction}
          onImport={onImport}
          onDefer={onDefer}
          onRetireAction={onRetireAction}
          full
        />

        <footer className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className={`text-xs ${isDay ? "text-neutral-500" : "text-zinc-500"}`}>
            La aplicación se abrirá automáticamente cuando no queden notas pendientes.
          </p>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className={`inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isDay
                ? "text-neutral-600 hover:bg-neutral-100 border border-neutral-200"
                : "text-zinc-300 hover:bg-zinc-800 border border-zinc-700"
            }`}
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Volver a comprobar
          </button>
        </footer>
      </div>
    </div>
  );
}

export default MigrationScreen;
