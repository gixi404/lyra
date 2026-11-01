export function acceptsSyncStart(connected: boolean, loginInProgress: boolean): boolean {
  return connected || loginInProgress;
}

export type SyncReason = "background" | "initial_connection" | "authorization";

export function isVisibleSyncReason(reason: SyncReason): boolean {
  return reason === "initial_connection" || reason === "authorization";
}

export function shouldShowSyncStart(
  reason: SyncReason,
  requestId: string | null | undefined,
  activeRequests: ReadonlySet<string>,
): boolean {
  return isVisibleSyncReason(reason) && Boolean(requestId && activeRequests.has(requestId));
}

export function shouldAcceptSyncStart(
  connected: boolean,
  loginInProgress: boolean,
  reason: SyncReason,
  requestId: string | null | undefined,
  activeRequests: ReadonlySet<string>,
): boolean {
  return acceptsSyncStart(connected, loginInProgress) &&
    (!isVisibleSyncReason(reason) || shouldShowSyncStart(reason, requestId, activeRequests));
}

export function acceptsSyncCompletion(
  activeId: string | null,
  eventId: string | undefined,
  connected: boolean,
  loginInProgress: boolean
): boolean {
  return acceptsSyncStart(connected, loginInProgress) &&
    activeId !== null && eventId === activeId;
}

export interface SyncEventContext {
  workspace_id: string;
  epoch: number;
}

export function sameSyncContext(
  event: SyncEventContext | null | undefined,
  active: { workspaceId: string; epoch: number } | null,
): boolean {
  return Boolean(event && active && event.workspace_id === active.workspaceId && event.epoch === active.epoch);
}
