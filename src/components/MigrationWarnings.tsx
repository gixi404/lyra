import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, ShieldAlert } from "lucide-react";
import { themes } from "../utils/helpers";
import {
  hasStartupWarnings,
  isWorkspaceReadOnly,
  pendingWarnings,
  type ItemAction,
  type RetireAction,
  type WorkspaceSnapshot,
} from "../utils/workspaceState";
import MigrationDetails from "./MigrationDetails";

interface Props {
  snapshot: WorkspaceSnapshot;
  busy: boolean;
  onItemAction: (name: string, action: ItemAction) => void;
  onImport: (name: string) => void;
  onDefer: (name: string) => void;
  onRetireAction: (name: string, action: RetireAction) => void;
}

/**
 * Non-blocking reminder that something is still pending.
 *
 * It is shown only once the app can start, and it cannot be dismissed while a
 * note is still pending: the only way to make it disappear is to resolve the
 * note (import it, keep it pending on purpose, or decide what to do with an
 * original that could not be retired). Collapsing it hides the list but keeps
 * the counter visible, so nothing disappears silently.
 */
function MigrationWarnings({
  snapshot,
  busy,
  onItemAction,
  onImport,
  onDefer,
  onRetireAction,
}: Props): JSX.Element | null {
  const { isDay } = themes();
  const [open, setOpen] = useState(false);
  const previousProblems = useRef<number | null>(null);

  // New problems open the list again, so a note that shows up while the panel
  // is collapsed is never missed. On first render it stays collapsed: the
  // counter is visible, and a writing session is not covered by a panel.
  const problems = pendingWarnings(snapshot);
  useEffect(() => {
    if (previousProblems.current !== null && problems > previousProblems.current) {
      setOpen(true);
    }
    previousProblems.current = problems;
  }, [problems]);

  const toggle = useCallback(() => setOpen(current => !current), []);

  if (!hasStartupWarnings(snapshot)) return null;

  const readOnly = isWorkspaceReadOnly(snapshot);
  const container = isDay
    ? "bg-white/95 border-neutral-200 text-neutral-900 shadow-neutral-900/10"
    : "bg-zinc-900/95 border-zinc-800 text-zinc-100 shadow-black/40";
  const muted = isDay ? "text-neutral-600" : "text-zinc-400";
  const toggleClass = isDay
    ? "text-neutral-500 hover:bg-neutral-100 rounded-lg"
    : "text-zinc-400 hover:bg-zinc-800 rounded-lg";

  return (
    <aside
      aria-label="Avisos del espacio de trabajo"
      className={`fixed bottom-4 right-4 z-40 w-[min(380px,calc(100vw-2rem))] rounded-2xl border shadow-2xl backdrop-blur ${container}`}
    >
      <div className="flex items-start gap-2 p-3">
        {readOnly ? (
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        ) : (
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {readOnly && problems === 0
              ? "Espacio de solo lectura"
              : `${problems} ${problems === 1 ? "nota pendiente" : "notas pendientes"}`}
          </p>
          <p className={`mt-0.5 text-xs ${muted}`}>
            {readOnly
              ? "Puedes leer tus notas; para editarlas hay que recuperar el vínculo del espacio."
              : "Siguen intactas en Documentos/lyra hasta que decidas qué hacer con ellas."}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {busy && (
            <Loader2
              className={`w-4 h-4 animate-spin ${muted}`}
              aria-label="Procesando"
            />
          )}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls="lyra-workspace-warnings"
            aria-label={open ? "Contraer avisos" : "Ver avisos"}
            className={`p-1.5 transition-colors ${toggleClass}`}
          >
            {open ? (
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {open && (problems > 0 || readOnly) && (
        <div
          id="lyra-workspace-warnings"
          className={`max-h-[60vh] overflow-y-auto border-t px-3 py-3 ${
            isDay ? "border-neutral-200" : "border-zinc-800"
          }`}
        >
          <MigrationDetails
            snapshot={snapshot}
            busy={busy}
            onItemAction={onItemAction}
            onImport={onImport}
            onDefer={onDefer}
            onRetireAction={onRetireAction}
          />
        </div>
      )}
    </aside>
  );
}

export default MigrationWarnings;
