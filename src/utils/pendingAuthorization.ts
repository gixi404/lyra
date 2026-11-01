/**
 * Lógica pura de la solicitud de consentimiento para subir notas locales a una
 * cuenta de Google Drive (AUD-001).
 *
 * Se mantiene separada del store y de la UI para poder verificarla sin Tauri.
 * Autorizar notas es una decisión explícita: nada aquí autoriza por sí solo.
 */

export interface PendingAuthorizationRequest {
  accountKey: string;
  accountEmail?: string | null;
  requestId: string;
  noteCount: number;
  notes: PendingAuthorizationNote[];
  createdAt: number;
}

export interface PendingAuthorizationNote {
  noteId: string;
  name: string;
}

export interface PendingAuthorizationMessages {
  title: string;
  destination: string;
  summary: string;
  warning: string;
}

const MAX_LISTED_NOTES = 6;

export function accountLabel(request: PendingAuthorizationRequest): string {
  const email = request.accountEmail?.trim();
  return email && email.length > 0 ? email : request.accountKey;
}

export function summarizeNotes(notes: string[], max: number = MAX_LISTED_NOTES): string {
  if (notes.length === 0) return "";
  if (notes.length <= max) return notes.join(", ");
  const rest = notes.length - max;
  return `${notes.slice(0, max).join(", ")} y ${rest} ${rest === 1 ? "nota más" : "notas más"}`;
}

export function buildPendingAuthorizationMessages(
  request: PendingAuthorizationRequest
): PendingAuthorizationMessages {
  const label = accountLabel(request);
  const count = request.noteCount;
  const noun = count === 1 ? "nota" : "notas";
  const verb = count === 1 ? "está" : "están";
  const determiner = count === 1 ? "esta" : "estas";

  return {
    title: "Autorizar notas en Google Drive",
    destination: `Cuenta de destino: ${label}`,
    summary: `${count} ${noun} de este equipo no ${verb} autorizadas para esa cuenta`,
    warning: `Si autorizas, el contenido de ${determiner} ${noun} se subirá a ${label}. Las notas futuras no se autorizan automáticamente`,
  };
}

export function canConfirmAuthorization(
  request: PendingAuthorizationRequest | null,
  isProcessing: boolean,
  selectedIds: readonly string[] = []
): boolean {
  if (!request || isProcessing || selectedIds.length === 0) return false;
  const allowed = new Set(request.notes.map(note => note.noteId));
  return selectedIds.length === new Set(selectedIds).size && selectedIds.every(id => allowed.has(id));
}

export function shouldRefreshPending(
  result: { pending_authorization?: boolean } | null | undefined
): boolean {
  return Boolean(result?.pending_authorization);
}

/**
 * Decide qué solicitud debe mostrarse. Un conjunto ya descartado en esta sesión
 * no se vuelve a abrir, y una solicitud ausente cierra el diálogo.
 */
export function nextPendingRequest(
  incoming: PendingAuthorizationRequest | null | undefined,
  dismissedRequestIds: ReadonlySet<string>
): PendingAuthorizationRequest | null {
  if (!incoming) return null;
  if (dismissedRequestIds.has(incoming.requestId)) return null;
  return incoming;
}

export interface LocalNoteStatusItem {
  noteId: string;
  name: string;
  status: "authorized" | "pending" | "declined" | "internal" | "blocked";
}

export interface LocalNoteManagementData {
  accountKey: string;
  accountEmail?: string | null;
  notes: LocalNoteStatusItem[];
  request: PendingAuthorizationRequest | null;
}

/**
 * Determina si existen notas locales pendientes o rechazadas que requieran
 * o permitan ser gestionadas/autorizadas para la cuenta conectada.
 */
export function hasManageableLocalNotes(
  view: LocalNoteManagementData | null | undefined
): boolean {
  if (!view) return false;
  const hasUnapprovedStatus =
    Array.isArray(view.notes) &&
    view.notes.some(
      note => note.status === "pending" || note.status === "declined"
    );
  const hasPendingRequest = Boolean(
    view.request &&
      Array.isArray(view.request.notes) &&
      view.request.notes.length > 0
  );
  return hasUnapprovedStatus || hasPendingRequest;
}
