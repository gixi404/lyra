import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, ShieldAlert } from "lucide-react";
import { themes } from "../utils/helpers";
import { useSyncStore } from "../store/syncStore";
import {
  buildPendingAuthorizationMessages,
  canConfirmAuthorization,
} from "../utils/pendingAuthorization";

/**
 * Consentimiento explícito para subir notas locales a una cuenta de Google Drive
 * (AUD-001). No hay ninguna casilla premarcada: la única forma de autorizar es
 * pulsar el botón de autorizar para esta solicitud concreta.
 *
 * Cerrar el diálogo (Escape, fondo o "Ahora no") no autoriza nada y deja las
 * notas intactas en el equipo.
 */
function PendingAuthorizationDialog(): JSX.Element | null {
  const { isDay } = themes();
  const request = useSyncStore(state => state.pendingAuthorization);
  const isProcessing = useSyncStore(state => state.isAuthorizingPending);
  const error = useSyncStore(state => state.pendingAuthorizationError);
  const managementNotes = useSyncStore(state => state.managementNotes);
  const managementAccountLabel = useSyncStore(state => state.managementAccountLabel);
  const authorizePending = useSyncStore(state => state.authorizePending);
  const dismissPending = useSyncStore(state => state.dismissPending);

  const dialogRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => setSelectedIds([]), [request?.requestId]);

  useEffect(() => {
    if (!request && !managementNotes) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void dismissPending();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      cancelAnimationFrame(frame);
    };
  }, [request, managementNotes, dismissPending]);

  if (!request && !managementNotes) return null;

  const messages = request ? buildPendingAuthorizationMessages(request) : null;
  const canConfirm = canConfirmAuthorization(request, isProcessing, selectedIds);
  const allSelected = Boolean(request?.notes.length) && selectedIds.length === request?.notes.length;
  const targetElement = document.getElementById("modal-root") || document.body;

  return createPortal(
    <div
      className="fixed inset-0 z-[99990] flex items-center justify-center p-4 bg-black/70"
      onMouseDown={event => event.stopPropagation()}
      onClick={() => void dismissPending()}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-auth-title"
        aria-describedby="pending-auth-description pending-auth-warning"
        onClick={event => event.stopPropagation()}
        className={`w-[480px] max-w-[92vw] p-6 rounded-2xl shadow-2xl border outline-none ${
          isDay
            ? "bg-white border-neutral-200 text-neutral-900"
            : "bg-zinc-900 border-zinc-800 text-zinc-100"
        }`}
      >
        <div className="flex items-start gap-3">
          <ShieldAlert
            className={`w-5 h-5 mt-0.5 shrink-0 ${
              isDay ? "text-amber-600" : "text-amber-400"
            }`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 id="pending-auth-title" className="text-lg font-semibold tracking-tight">
              {messages?.title ?? "Gestionar notas locales"}
            </h2>
            <p
              id="pending-auth-description"
              className={`mt-1 text-sm ${isDay ? "text-neutral-600" : "text-zinc-400"}`}
            >
              <span className="block font-medium">{messages?.destination ?? `Cuenta de destino: ${managementAccountLabel ?? "cuenta actual"}`}</span>
              <span className="block">{messages?.summary ?? "No hay notas pendientes de autorización"}</span>
            </p>
          </div>
        </div>

        <ul
          className={`mt-4 max-h-40 overflow-y-auto rounded-xl border px-3 py-2 text-sm space-y-1 ${
            isDay
              ? "border-neutral-200 bg-neutral-50 text-neutral-700"
              : "border-zinc-800 bg-zinc-800/60 text-zinc-300"
          }`}
        >
          {request?.notes.map(note => (
            <li key={note.noteId}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={selectedIds.includes(note.noteId)} disabled={isProcessing}
                  onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, note.noteId] : ids.filter(id => id !== note.noteId))} />
                <span className="truncate">{note.name}</span>
              </label>
            </li>
          ))}
        </ul>

        {request && <div className="mt-2 flex items-center justify-between text-xs">
          <button type="button" onClick={() => setSelectedIds(allSelected ? [] : request.notes.map(note => note.noteId))} disabled={isProcessing}>
            {allSelected ? "Deseleccionar todas" : "Seleccionar todas"}
          </button>
          <span>{selectedIds.length} de {request.notes.length} notas seleccionadas</span>
        </div>}

        {managementNotes && <ul className="mt-3 max-h-28 overflow-y-auto text-xs">
          {managementNotes.filter(note => note.status !== "pending").map(note => <li key={note.noteId}>
            {note.name}: {note.status === "authorized" ? "vinculada" : note.status === "internal" ? "nota interna excluida" : note.status === "declined" ? "no autorizada" : "bloqueada"}
          </li>)}
        </ul>}

        <p
          id="pending-auth-warning"
          className={`mt-4 text-sm ${isDay ? "text-neutral-700" : "text-zinc-300"}`}
        >
          {messages?.warning ?? "Puedes volver a esta pantalla para autorizar notas en otro momento."}
        </p>

        {error && (
          <p
            role="alert"
            className={`mt-4 text-sm rounded-xl px-3 py-2 border ${
              isDay
                ? "text-rose-700 border-rose-200 bg-rose-50"
                : "text-rose-300 border-rose-900/60 bg-rose-950/40"
            }`}
          >
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={() => void dismissPending()}
            disabled={isProcessing}
            className={`px-4 py-2 text-sm font-medium rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isDay
                ? "text-neutral-600 hover:bg-neutral-100"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
              {managementNotes ? "Cerrar" : "Cancelar"}
          </button>
          {request && <button
            type="button"
            onClick={() => void authorizePending(selectedIds)}
            disabled={!canConfirm}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl transition-all shadow-sm disabled:opacity-60 disabled:cursor-not-allowed ${
              isDay
                ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-600/20"
                : "bg-sky-500 hover:bg-sky-400 text-zinc-950 font-semibold shadow-sky-500/20"
            }`}
          >
            {isProcessing && (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            )}
            {isProcessing
              ? "Autorizando..."
              : `Autorizar ${selectedIds.length} ${
                  selectedIds.length === 1 ? "nota" : "notas"
                }`}
          </button>}
        </div>
      </div>
    </div>,
    targetElement
  );
}

export default PendingAuthorizationDialog;
