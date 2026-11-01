import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { notification } from "../utils/helpers";
import { autoArchiveWelcomeOnSync } from "../utils/welcome";
import { refreshArchiveState } from "../utils/archiveState";
import {
  accountLabel,
  hasManageableLocalNotes,
  nextPendingRequest,
  type PendingAuthorizationRequest,
} from "../utils/pendingAuthorization";
import { fileStore } from "./fileStore";
import { acceptsSyncCompletion, isVisibleSyncReason, sameSyncContext, shouldAcceptSyncStart, shouldShowSyncStart, type SyncEventContext, type SyncReason } from "../utils/syncEventPolicy";
import { useToastStore } from "./toastStore";
import { noteLabel } from "../utils/noteName";
import { currentSyncRequest } from "../utils/workspacePaths";
import { getWorkspaceState } from "../utils/workspaceClient";

export interface SyncStatusPayload {
  is_connected: boolean;
  is_syncing: boolean;
  user_email?: string | null;
  user_name?: string | null;
  user_photo?: string | null;
  last_sync_timestamp?: number | null;
  last_error?: string | null;
  auto_sync_enabled: boolean;
  backend_version?: string | null;
  backend_build_timestamp?: string | null;
}

export interface SyncResultPayload {
  sync_id?: string;
  uploaded: string[];
  downloaded: string[];
  conflicts: string[];
  deleted_remote: string[];
  errors: string[];
  pending_authorization?: boolean;
  blocked_uploads?: string[];
  archive_conflicts?: string[];
}

export type PendingAuthorizationPayload = PendingAuthorizationRequest;

export interface LocalNoteStatus {
  noteId: string;
  name: string;
  status: "authorized" | "pending" | "declined" | "internal" | "blocked";
}

interface LocalNoteManagement {
  accountKey: string;
  accountEmail?: string | null;
  notes: LocalNoteStatus[];
  request: PendingAuthorizationRequest | null;
}

export interface UserProfilePayload {
  email: string;
  name?: string | null;
  picture?: string | null;
}

export interface SyncStoreState {
  isConnected: boolean;
  isSyncing: boolean;
  userEmail: string | null;
  userName: string | null;
  userPhoto: string | null;
  lastSyncTimestamp: number | null;
  lastError: string | null;
  isInitialized: boolean;
  backendVersion: string | null;
  backendBuildTimestamp: string | null;
  pendingAuthorization: PendingAuthorizationRequest | null;
  isAuthorizingPending: boolean;
  pendingAuthorizationError: string | null;
  managementNotes: LocalNoteStatus[] | null;
  managementAccountLabel: string | null;
  hasManageableNotes: boolean;

  fetchStatus: () => Promise<void>;
  login: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<boolean>;
  syncNow: (silent?: boolean, force?: boolean, reason?: "background" | "authorization") => Promise<void>;
  refreshPendingAuthorization: () => Promise<void>;
  checkManageableNotes: () => Promise<boolean>;
  authorizePending: (selectedIds: string[]) => Promise<void>;
  manageLocalNotes: (reopenDeclined?: boolean) => Promise<void>;
  dismissPending: () => Promise<void>;
}

let listenersInitialized = false;
let listenersPromise: Promise<void> | null = null;
let activeSyncToastId: string | null = null;
let activeBackendSyncId: string | null = null;
let activeBackendSyncReason: SyncReason = "background";
let activeBackendRequestId: string | null = null;
const visibleSyncRequests = new Set<string>();
let activeLoginRequestId: string | null = null;
let loginInProgress = false;
let logoutInProgress = false;
let connectionGeneration = 0;
let isManualSyncActive = false;
let syncQueued = false;
let queuedIsManual = false;
let queuedReason: "background" | "authorization" = "background";
let frontendSyncInvokeActive = false;
let autoSyncThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let lastAutoSyncTimestamp = 0;
let notifiedArchiveConflicts = new Set<string>();
const AUTO_SYNC_MIN_INTERVAL_MS = 5_000;

/** Solicitudes que el usuario descartó en esta sesión (no se autorizó nada). */
const dismissedPendingRequestIds = new Set<string>();

export type PreSyncHandler = () => Promise<boolean>;
let preSyncHandler: PreSyncHandler | null = null;

export function registerPreSyncHandler(handler: PreSyncHandler): () => void {
  preSyncHandler = handler;
  return () => {
    if (preSyncHandler === handler) {
      preSyncHandler = null;
    }
  };
}

export function resetSyncForWorkspace(): void {
  connectionGeneration += 1;
  if (autoSyncThrottleTimer) clearTimeout(autoSyncThrottleTimer);
  autoSyncThrottleTimer = null;
  syncQueued = false;
  queuedIsManual = false;
  queuedReason = "background";
  lastAutoSyncTimestamp = 0;
  frontendSyncInvokeActive = false;
  isManualSyncActive = false;
  activeBackendSyncId = null;
  activeBackendRequestId = null;
  activeBackendSyncReason = "background";
  activeLoginRequestId = null;
  visibleSyncRequests.clear();
  dismissedPendingRequestIds.clear();
  notifiedArchiveConflicts = new Set();
  dismissSyncToast();
  useSyncStore.setState({ isSyncing: false, lastError: null, lastSyncTimestamp: null,
    pendingAuthorization: null, pendingAuthorizationError: null,
    isAuthorizingPending: false, managementNotes: null,
    managementAccountLabel: null, hasManageableNotes: false });
}

function showSyncToast(): void {
  const currentToasts = useToastStore.getState().toasts;
  if (activeSyncToastId !== null && currentToasts.some(t => t.id === activeSyncToastId)) {
    return;
  }
  activeSyncToastId = useToastStore.getState().addToast("loading", "Sincronizando...", undefined, 0);
}

function dismissSyncToast(): void {
  if (activeSyncToastId !== null) {
    useToastStore.getState().removeToast(activeSyncToastId);
    activeSyncToastId = null;
  }
}

function initSyncListeners(): Promise<void> {
  if (listenersInitialized || typeof window === "undefined") return Promise.resolve();
  if (listenersPromise) return listenersPromise;
  listenersPromise = registerSyncListeners().finally(() => { listenersPromise = null; });
  return listenersPromise;
}

async function registerSyncListeners(): Promise<void> {
  const registrations = [listen<{ sync_id: string; reason: SyncReason; request_id?: string | null } & SyncEventContext>("gdrive:sync_started", event => {
    if (sameSyncContext(event.payload, currentSyncRequest()) && !logoutInProgress && shouldAcceptSyncStart(
      useSyncStore.getState().isConnected, loginInProgress,
      event.payload.reason, event.payload.request_id, visibleSyncRequests,
    )) {
      activeBackendSyncId = event.payload.sync_id;
      activeBackendRequestId = event.payload.request_id ?? null;
      const visible = shouldShowSyncStart(event.payload.reason, activeBackendRequestId, visibleSyncRequests);
      activeBackendSyncReason = visible ? event.payload.reason : "background";
      useSyncStore.setState({ isSyncing: true, lastError: null });
      if (visible) showSyncToast();
      else dismissSyncToast();
    }
  }),
  listen<SyncEventContext>("gdrive:download_start", event => {
    if (!sameSyncContext(event.payload, currentSyncRequest())) return;
    console.log("[SyncListener] Evento gdrive:download_start recibido");
  }),

  listen<{ name: string } & SyncEventContext>("gdrive:file_downloaded", event => {
    if (!sameSyncContext(event.payload, currentSyncRequest())) return;
    const fileName = event.payload?.name;
    console.log("[SyncListener] Evento gdrive:file_downloaded recibido:", fileName);
    if (fileName) {
      fileStore.getState().updateListFiles(fileName);
      fileStore.getState().editedFile();
    }
  }),

  listen<SyncEventContext>("gdrive:download_finish", event => {
    if (!sameSyncContext(event.payload, currentSyncRequest())) return;
    console.log("[SyncListener] Evento gdrive:download_finish recibido");
  }),

  listen<SyncResultPayload & SyncEventContext>("gdrive:sync_finished", event => {
    if (!sameSyncContext(event.payload, currentSyncRequest())) return;
    const eventContext = event.payload;
    console.log("[SyncListener] Evento gdrive:sync_finished recibido:", event.payload);
    if (logoutInProgress || !acceptsSyncCompletion(activeBackendSyncId, event.payload.sync_id, useSyncStore.getState().isConnected, loginInProgress)) return;
    const completedReason = activeBackendSyncReason;
    if (activeBackendRequestId) visibleSyncRequests.delete(activeBackendRequestId);
    if (activeBackendRequestId === activeLoginRequestId) activeLoginRequestId = null;
    activeBackendSyncId = null;
    activeBackendRequestId = null;
    activeBackendSyncReason = "background";
    dismissSyncToast();
    const res = event.payload;
    const hasErrors = Boolean(res && res.errors && res.errors.length > 0);
    if (hasErrors && !isManualSyncActive) notification("error", "No se pudo completar la sincronización");
    else if (!isManualSyncActive && isVisibleSyncReason(completedReason) && !res.pending_authorization &&
      res && (res.uploaded.length + res.downloaded.length + res.deleted_remote.length > 0))
      notification("success", "Sincronización completada");
    useSyncStore.setState({
      isSyncing: false,
      lastSyncTimestamp: Date.now(),
      lastError: hasErrors ? res.errors[0] : null,
    });
    if (!frontendSyncInvokeActive && syncQueued) {
      const manual = queuedIsManual;
      const reason = queuedReason;
      syncQueued = false;
      queuedIsManual = false;
      queuedReason = "background";
      setTimeout(() => {
        if (sameSyncContext(eventContext, currentSyncRequest())) void useSyncStore.getState().syncNow(!manual, true, reason);
      }, 0);
    }
    useSyncStore.setState({ pendingAuthorization: null, pendingAuthorizationError: null });
    if (res && (res.downloaded.length > 0 || res.conflicts.length > 0)) {
      void autoArchiveWelcomeOnSync(res.downloaded).then(archived => {
        if (sameSyncContext(eventContext, currentSyncRequest()) && archived && useSyncStore.getState().isConnected && navigator.onLine) {
          void useSyncStore.getState().syncNow(true);
        }
      }).finally(() => {
        if (sameSyncContext(eventContext, currentSyncRequest())) fileStore.getState().editedFile();
      });
    }
    void refreshArchiveState().then(projection => {
      if (!sameSyncContext(eventContext, currentSyncRequest())) return;
      const current = new Set(projection.conflictNames);
      const fresh = projection.conflictNames.filter(name => !notifiedArchiveConflicts.has(name));
      notifiedArchiveConflicts = current;
      if (fresh.length > 0) {
        notification("info", `Conflicto de archivado resuelto a favor de archivada: ${fresh.map(noteLabel).join(", ")}`);
      }
    }).catch(error => console.warn("Could not refresh archive state", error));
  }),

  listen<{ sync_id: string; message: string } & SyncEventContext>("gdrive:sync_error", event => {
    if (!sameSyncContext(event.payload, currentSyncRequest())) return;
    console.error("[SyncListener] Evento gdrive:sync_error recibido:", event.payload);
    if (logoutInProgress || !acceptsSyncCompletion(activeBackendSyncId, event.payload.sync_id, useSyncStore.getState().isConnected, loginInProgress)) return;
    activeBackendSyncId = null;
    if (activeBackendRequestId) visibleSyncRequests.delete(activeBackendRequestId);
    if (activeBackendRequestId === activeLoginRequestId) activeLoginRequestId = null;
    activeBackendRequestId = null;
    activeBackendSyncReason = "background";
    dismissSyncToast();
    if (!isManualSyncActive) notification("error", "No se pudo completar la sincronización");
    useSyncStore.setState({ isSyncing: false, lastError: event.payload.message });
  })];
  const results = await Promise.allSettled(registrations);
  if (results.some(result => result.status === "rejected")) {
    for (const result of results) {
      if (result.status === "fulfilled") result.value();
    }
    throw new Error("Could not register all Google Drive listeners");
  }
  listenersInitialized = true;
}

if (typeof window !== "undefined") {
  void initSyncListeners().catch(error => console.warn("Google Drive listeners unavailable", error));
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  isConnected: false,
  isSyncing: false,
  userEmail: null,
  userName: null,
  userPhoto: null,
  lastSyncTimestamp: null,
  lastError: null,
  isInitialized: false,
  backendVersion: null,
  backendBuildTimestamp: null,
  pendingAuthorization: null,
  isAuthorizingPending: false,
  pendingAuthorizationError: null,
  managementNotes: null,
  managementAccountLabel: null,
  hasManageableNotes: false,

  fetchStatus: async () => {
    const generation = connectionGeneration;
    const request = currentSyncRequest();
    if (!request) return;
    try {
      await initSyncListeners();
    } catch (error) {
      console.warn("Google Drive listeners will be retried before sync", error);
    }
    try {
      const status = await invoke<SyncStatusPayload>("gdrive_get_status", { request });
      if (generation !== connectionGeneration || !sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) return;
      console.log("[SyncStore] gdrive_get_status:", status);
      set({
        isConnected: status.is_connected,
        isSyncing: status.is_syncing,
        userEmail: status.user_email ?? null,
        userName: status.user_name ?? null,
        userPhoto: status.user_photo ?? null,
        lastSyncTimestamp: status.last_sync_timestamp ?? null,
        lastError: status.last_error ?? null,
        backendVersion: status.backend_version ?? null,
        backendBuildTimestamp: status.backend_build_timestamp ?? null,
        isInitialized: true,
        ...(status.is_connected
          ? {}
          : { pendingAuthorization: null, pendingAuthorizationError: null }),
      });
      set({ hasManageableNotes: false, pendingAuthorization: null, pendingAuthorizationError: null });
    } catch (err: any) {
      if (generation !== connectionGeneration || !sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) return;
      console.warn("No se pudo obtener el estado de sincronización de Google Drive:", err);
      set({
        isInitialized: true,
        isConnected: false,
        userEmail: null,
        userName: null,
        userPhoto: null,
        pendingAuthorization: null,
        lastError: err?.message || String(err),
      });
    }
  },

  login: async () => {
    const request = currentSyncRequest();
    if (!request) return;
    const stillCurrent = () => sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest());
    const loginRequestId = `login-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    activeLoginRequestId = loginRequestId;
    visibleSyncRequests.add(loginRequestId);
    loginInProgress = true;
    set({ isSyncing: true, lastError: null });
    try {
      await initSyncListeners();
      notification("info", "Preparando conexión segura con Google Drive...");
      const user = await invoke<UserProfilePayload>("gdrive_login", { clientRequestId: loginRequestId });
      if (currentSyncRequest()?.workspaceId !== request.workspaceId) return;
      const snapshot = await getWorkspaceState();
      if (snapshot.workspace?.id !== request.workspaceId) return;
      window.dispatchEvent(new Event("lyra:workspace_binding_changed"));
      connectionGeneration += 1;
      dismissedPendingRequestIds.clear();
      set({
        isConnected: true,
        userEmail: user.email,
        userName: user.name ?? null,
        userPhoto: user.picture ?? null,
        lastError: null,
        pendingAuthorization: null,
        pendingAuthorizationError: null,
        managementNotes: null,
        managementAccountLabel: null,
      });
      notification("success", `Conectado a Google Drive como ${user.email}`);
      await get().fetchStatus();
      await refreshArchiveState();
    } catch (err: any) {
      if (!stillCurrent()) return;
      visibleSyncRequests.delete(loginRequestId);
      if (activeLoginRequestId === loginRequestId) activeLoginRequestId = null;
      set({ isSyncing: false });
      const msg = err?.message || String(err);
      if (msg.includes("cancelado")) {
        // Conexión cancelada: no mostrar notificación
      } else if (
        msg.includes("Tiempo de espera agotado") ||
        msg.toLowerCase().includes("tiempo de espera")
      ) {
        const timeoutMsg =
          "Se agotó el tiempo para conectar con Google Drive. Intenta nuevamente";
        set({ lastError: timeoutMsg });
        notification("error", timeoutMsg, undefined, 7000);
      } else {
        set({ lastError: msg });
        notification("error", "No se pudo conectar con Google Drive", undefined, 6000);
      }
    } finally {
      loginInProgress = false;
    }
  },

  cancelLogin: async () => {
    try {
      await invoke("gdrive_cancel_login");
      if (activeLoginRequestId) visibleSyncRequests.delete(activeLoginRequestId);
      activeLoginRequestId = null;
      activeBackendSyncId = null;
      activeBackendRequestId = null;
      activeBackendSyncReason = "background";
      dismissSyncToast();
      set({ isSyncing: false });
    } catch (err: any) {
      console.warn("Error al cancelar login:", err);
    }
  },

  logout: async () => {
    logoutInProgress = true;
    visibleSyncRequests.clear();
    activeLoginRequestId = null;
    activeBackendRequestId = null;
    activeBackendSyncId = null;
    dismissSyncToast();
    try {
      const remoteRevoked = await invoke<boolean>("gdrive_logout");
      connectionGeneration += 1;
      isManualSyncActive = false;
      syncQueued = false;
      queuedIsManual = false;
      queuedReason = "background";
      dismissSyncToast();
      activeBackendSyncId = null;
      dismissedPendingRequestIds.clear();
      set({
        isConnected: false,
        isSyncing: false,
        userEmail: null,
        userName: null,
        userPhoto: null,
        lastSyncTimestamp: null,
        lastError: null,
        pendingAuthorization: null,
        isAuthorizingPending: false,
        pendingAuthorizationError: null,
        managementNotes: null,
        managementAccountLabel: null,
        hasManageableNotes: false,
      });
      if (remoteRevoked === false) {
        notification(
          "info",
          "Cuenta desconectada de Lyra. No se pudo revocar el acceso en Google",
          undefined,
          6000
        );
      }
      try {
        await refreshArchiveState();
      } catch (error) {
        console.warn("Could not refresh archive view after logout", error);
      }
      return true;
    } catch (err: any) {
      notification("error", "No se pudo desconectar la cuenta");
      void get().fetchStatus();
      return false;
    } finally {
      logoutInProgress = false;
    }
  },

  syncNow: async (silent = false, force = false, reason = "background") => {
    const state = get();
    const request = currentSyncRequest();
    if (!request) return;
    const stillCurrent = () => sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest());
    const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const isManual = !silent;
    console.log(`[SyncStore ${reqId}] syncNow(silent=${silent}, force=${force}) invocado. isConnected=${state.isConnected}, isSyncing=${state.isSyncing}`);

    if (!state.isConnected) {
      console.warn(`[SyncStore ${reqId}] Sincronización omitida: cuenta no conectada.`);
      return;
    }

    if (isManual && autoSyncThrottleTimer) {
      clearTimeout(autoSyncThrottleTimer);
      autoSyncThrottleTimer = null;
    }

    if (state.isSyncing) {
      console.warn(`[SyncStore ${reqId}] Sincronización en curso. Marcando trailing sync.`);
      syncQueued = true;
      if (reason === "authorization") queuedReason = "authorization";
      if (isManual) {
        queuedIsManual = true;
        isManualSyncActive = true;
      }
      return;
    }

    // Si es sincronización automática y aún no transcurre el intervalo mínimo (5s):
    // Posponer para el tiempo restante en lugar de descartarla, asegurando que ningún cambio nuevo se pierda.
    if (!isManual && !force && Date.now() - lastAutoSyncTimestamp < AUTO_SYNC_MIN_INTERVAL_MS) {
      const elapsed = Date.now() - lastAutoSyncTimestamp;
      const remainingMs = Math.max(500, AUTO_SYNC_MIN_INTERVAL_MS - elapsed);
      console.log(`[SyncStore ${reqId}] Sincronización automática pospuesta ${remainingMs}ms por intervalo mínimo.`);
      if (!autoSyncThrottleTimer) {
        autoSyncThrottleTimer = setTimeout(() => {
          autoSyncThrottleTimer = null;
          if (stillCurrent()) void get().syncNow(true);
        }, remainingMs);
      }
      return;
    }

    if (autoSyncThrottleTimer) {
      clearTimeout(autoSyncThrottleTimer);
      autoSyncThrottleTimer = null;
    }

    try {
      await initSyncListeners();
    } catch (error) {
      if (stillCurrent()) set({ lastError: String(error) });
      return;
    }
    if (!stillCurrent()) return;
    isManualSyncActive = isManual;
    set({ isSyncing: true, lastError: null });

    // Barrera asíncrona estricta:
    // Si existe un editor activo con cambios pendientes, esperar a que finalice físicamente
    // el guardado a disco (flushAutosave) y se capture la revisión persistida (markSyncInFlight)
    // ANTES de que Rust comience la lectura de archivos locales.
    const currentPreSync = preSyncHandler;
    if (currentPreSync) {
      try {
        const canProceed = await currentPreSync();
        if (!stillCurrent()) return;
        if (!canProceed) {
          console.warn(`[SyncStore ${reqId}] El guardado previo a la sincronización falló. Cancelando ejecución.`);
          set({ isSyncing: false });
          if (isManual) {
            isManualSyncActive = false;
            dismissSyncToast();
            notification("error", "No se pudo guardar el archivo antes de sincronizar");
          }
          return;
        }
      } catch (err) {
        if (!stillCurrent()) return;
        console.error(`[SyncStore ${reqId}] Error en barrera preSyncHandler:`, err);
        set({ isSyncing: false });
        if (isManual) {
          isManualSyncActive = false;
          dismissSyncToast();
        }
        return;
      }
    }

    const startTime = Date.now();
    if (!stillCurrent()) return;
    frontendSyncInvokeActive = true;
    let backendQueued = false;
    const visibleRequestId = reason === "authorization" ? reqId : null;
    if (visibleRequestId) visibleSyncRequests.add(visibleRequestId);
    try {
      console.log(`[SyncStore ${reqId}] Invocando 'gdrive_sync_now'...`);
      const res = await invoke<SyncResultPayload>("gdrive_sync_now", { request, reason, requestId: visibleRequestId });
      if (!stillCurrent()) return;
      if (res.sync_id === "queued") {
        backendQueued = true;
        return;
      }
      const durationMs = Date.now() - startTime;
      console.log(`[SyncStore ${reqId}] Respuesta recibida en ${durationMs}ms:`, res);

      const hasErrors = res.errors && res.errors.length > 0;
      set({
        isSyncing: false,
        lastSyncTimestamp: Date.now(),
        lastError: hasErrors ? res.errors[0] : null,
      });

      set({ pendingAuthorization: null, pendingAuthorizationError: null });

      const totalChanges = res.uploaded.length + res.downloaded.length + res.deleted_remote.length;
      if (hasErrors) {
        console.warn(`[SyncStore ${reqId}] Errores devueltos:`, res.errors);
        if (!silent) {
          notification(
            "error",
            "No se pudo completar la sincronización",
            undefined,
            7000
          );
        }
      } else if (res.conflicts.length > 0) {
        console.warn(`[SyncStore ${reqId}] Conflictos detectados:`, res.conflicts);
        notification(
          "error",
          "Se detectaron conflictos en archivos. Se guardaron copias para conservar los cambios",
          undefined,
          7000
        );
      } else if (!silent && !res.pending_authorization) {
        if (totalChanges === 0) {
          notification("success", "Todo está sincronizado");
        } else {
          notification("success", "Sincronización completada");
        }
      }

      if (res.downloaded.length > 0 || res.conflicts.length > 0) {
        await autoArchiveWelcomeOnSync(res.downloaded);
        fileStore.getState().editedFile();
      }
    } catch (err: any) {
      if (!stillCurrent()) return;
      if (visibleRequestId) visibleSyncRequests.delete(visibleRequestId);
      const durationMs = Date.now() - startTime;
      const errMsg = err?.message || String(err);
      console.error(`[SyncStore ${reqId}] Fallo al invocar 'gdrive_sync_now' (${durationMs}ms):`, err);
      set({ isSyncing: false, lastError: errMsg });
      if (!silent) {
        notification("error", "No se pudo completar la sincronización");
      }
    } finally {
      if (!stillCurrent()) return;
      frontendSyncInvokeActive = false;
      if (backendQueued) return;
      const willRunQueued = syncQueued;
      const runManual = queuedIsManual;
      const runReason = queuedReason;
      syncQueued = false;
      queuedIsManual = false;
      queuedReason = "background";

      if (!isManual) {
        lastAutoSyncTimestamp = Date.now();
      }

      if (!willRunQueued) {
        isManualSyncActive = false;
        if (activeBackendSyncId === null) dismissSyncToast();
      } else {
        if (runManual) {
          isManualSyncActive = true;
        }
        setTimeout(() => {
          if (stillCurrent()) void get().syncNow(!runManual, true, runReason);
        }, 300);
      }
    }
  },

  checkManageableNotes: async () => {
    if (!get().isConnected) {
      set({ hasManageableNotes: false });
      return false;
    }
    const generation = connectionGeneration;
    const request = currentSyncRequest();
    if (!request) return false;
    try {
      const view = await invoke<LocalNoteManagement>("gdrive_manage_local_notes", { reopenDeclined: false, request });
      if (generation !== connectionGeneration || !get().isConnected || !sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) return false;
      const has = hasManageableLocalNotes(view);
      set({ hasManageableNotes: has });
      return has;
    } catch (err) {
      console.warn("No se pudo verificar notas gestionables:", err);
      return false;
    }
  },

  refreshPendingAuthorization: async () => {
    if (!get().isConnected) {
      set({ pendingAuthorization: null });
      return;
    }
    const generation = connectionGeneration;
    const context = currentSyncRequest();
    if (!context) return;
    try {
      const request = await invoke<PendingAuthorizationRequest | null>(
        "gdrive_get_pending_authorizations", { request: context }
      );
      if (generation !== connectionGeneration || !get().isConnected || !sameSyncContext({ workspace_id: context.workspaceId, epoch: context.epoch }, currentSyncRequest())) return;
      set({
        pendingAuthorization: nextPendingRequest(request, dismissedPendingRequestIds),
      });
    } catch (err) {
      console.warn(
        "No se pudo consultar las autorizaciones pendientes de Google Drive:",
        err
      );
    }
  },

  authorizePending: async (selectedIds: string[]) => {
    const { pendingAuthorization, isAuthorizingPending } = get();
    if (!pendingAuthorization || isAuthorizingPending) return;
    const label = accountLabel(pendingAuthorization);
    const generation = connectionGeneration;
    const request = currentSyncRequest();
    if (!request) return;
    set({ isAuthorizingPending: true, pendingAuthorizationError: null });
    try {
      const authorized = await invoke<number>("gdrive_authorize_pending", {
        requestId: pendingAuthorization.requestId,
        selectedIds,
        request,
      });
      if (generation !== connectionGeneration || !sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) return;
      dismissedPendingRequestIds.delete(pendingAuthorization.requestId);
      set({ pendingAuthorization: null, isAuthorizingPending: false, managementNotes: null, managementAccountLabel: null });
      const noun = authorized === 1 ? "nota autorizada" : "notas autorizadas";
      notification("success", `${authorized} ${noun} para ${label}`, undefined, 6000);
      if (authorized > 0) void get().syncNow(true, true, "authorization");
    } catch (err: any) {
      if (generation !== connectionGeneration || !sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) return;
      const msg = err?.message || String(err);
      console.warn("[SyncStore] No se pudo autorizar las notas pendientes:", err);
      set({ isAuthorizingPending: false });
      if (generation === connectionGeneration && get().isConnected) {
        await get().manageLocalNotes(false);
        set({ pendingAuthorizationError: msg });
      }
    }
  },

  manageLocalNotes: async (reopenDeclined = true) => {
    const generation = connectionGeneration;
    const request = currentSyncRequest();
    if (!request) return;
    try {
      const view = await invoke<LocalNoteManagement>("gdrive_manage_local_notes", { reopenDeclined, request });
      if (generation !== connectionGeneration || !get().isConnected || !sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) return;
      dismissedPendingRequestIds.clear();
      set({ managementNotes: view.notes, managementAccountLabel: view.accountEmail || view.accountKey,
        pendingAuthorization: view.request, pendingAuthorizationError: null });
    } catch (err) {
      if (generation === connectionGeneration && sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest()))
        notification("error", `No se pudieron consultar las notas locales: ${String(err)}`);
    }
  },

  dismissPending: async () => {
    const { pendingAuthorization, isAuthorizingPending } = get();
    if (isAuthorizingPending) return;
    if (pendingAuthorization) {
      const generation = connectionGeneration;
      const request = currentSyncRequest();
      if (!request) return;
      set({ isAuthorizingPending: true, pendingAuthorizationError: null });
      try {
        await invoke("gdrive_decline_pending", { requestId: pendingAuthorization.requestId, request });
        if (generation !== connectionGeneration || !sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) return;
        dismissedPendingRequestIds.add(pendingAuthorization.requestId);
      } catch (error) {
        if (generation === connectionGeneration && sameSyncContext({ workspace_id: request.workspaceId, epoch: request.epoch }, currentSyncRequest())) {
          set({ isAuthorizingPending: false, pendingAuthorizationError: String(error) });
        }
        return;
      }
    }
    set({ pendingAuthorization: null, pendingAuthorizationError: null, managementNotes: null,
      managementAccountLabel: null, isAuthorizingPending: false });
  },
}));
