import { RouterProvider } from "react-router-dom";
import { StrictMode, Suspense } from "react";
import Toast from "./components/Toast";
import "./styles.css";
import { type Container, createRoot } from "react-dom/client";
import { checkAndApplyUpdate, notifyIfJustUpdated } from "./utils/updater";
import { initPersistentPreferences } from "./utils/persistentPreferences";
import { initializeArchiveState, resetArchiveStateForWorkspace } from "./utils/archiveState";
import { initRecoveryNotifierForWorkspace } from "./utils/recoveryNotifier";
import { useSyncStore } from "./store/syncStore";
import { configStore } from "./store/configStore";
import { router } from "./router";
import WorkspaceGate from "./components/WorkspaceGate";
import { isDriveSyncPaused } from "./utils/workspaceClient";
import type { WorkspaceSnapshot } from "./utils/workspaceState";
import { currentNotesDir, currentSyncRequest } from "./utils/workspacePaths";
import { sameSyncContext } from "./utils/syncEventPolicy";
import { createWorkspaceRecoveryLifecycle } from "./utils/workspaceRecoveryLifecycle";

const root = document.getElementById("root") as Container;
const workspaceRecovery = createWorkspaceRecoveryLifecycle(currentNotesDir, initRecoveryNotifierForWorkspace);

if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

try {
  const isThemeMigrated = window.localStorage.getItem("lyra_theme_migrated_v2") === "true";
  if (!isThemeMigrated) {
    window.localStorage.setItem("lyra_theme_migrated_v2", "true");
    window.localStorage.setItem("theme", "auto");
  }

  const savedTheme = window.localStorage.getItem("theme");
  const isLight =
    savedTheme === "sunny-day" ||
    savedTheme === "Day" ||
    ((!savedTheme || savedTheme === "auto" || savedTheme === "nothing") &&
      !window.matchMedia("(prefers-color-scheme: dark)").matches);
  const isDark = !isLight;
  const initialBg = isDark ? "#101010" : "#e0e0e0";
  document.documentElement.style.backgroundColor = initialBg;
  document.body.style.backgroundColor = initialBg;
  if (isDark) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  } else {
    document.documentElement.classList.add("light");
    document.documentElement.classList.remove("dark");
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChange = () => {
    const currentStoredTheme = window.localStorage.getItem("theme");
    if (!currentStoredTheme || currentStoredTheme === "auto" || currentStoredTheme === "nothing") {
      configStore.getState().toggleThemeTick();
    }
  };
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener("change", handleMediaChange);
  } else if (mediaQuery.addListener) {
    mediaQuery.addListener(handleMediaChange);
  }
} catch {}

createRoot(root).render(
  <StrictMode>
    <WorkspaceGate onReady={bootstrapWorkspace}>
      <Suspense fallback={<div className="w-full min-h-screen bg-[#101010] light:bg-[#e0e0e0]" />}>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </Suspense>
    </WorkspaceGate>
    <Toast />
  </StrictMode>
);

// Notificar si la app acaba de ser actualizada
setTimeout(() => {
  void notifyIfJustUpdated();
}, 600);

// Comprobación de actualizaciones al iniciar si hay conexión a internet
if (typeof navigator !== "undefined" && navigator.onLine) {
  setTimeout(() => {
    void checkAndApplyUpdate(false);
  }, 2500);
}

// Inicializar estado de Google Drive y sincronizar si está conectado.
// Se ejecuta solo cuando la puerta de espacios de trabajo se ha abierto: antes
// de eso la carpeta de notas todavía se está migrando.
let preferencesInitialized = false;

async function bootstrapWorkspace(snapshot: WorkspaceSnapshot): Promise<void> {
  // The backend queue retains early recovery events until this first drain.
  await workspaceRecovery.onReady(snapshot);
  if (!preferencesInitialized) {
    await initPersistentPreferences();
    preferencesInitialized = true;
  }
  resetArchiveStateForWorkspace();
  await initializeArchiveState(snapshot.workspace?.id === snapshot.legacyWorkspaceId &&
    snapshot.workspaces.length === 1);
  await useSyncStore.getState().fetchStatus();
  const syncState = useSyncStore.getState();
  if (
    snapshot.drivePaused ||
    isDriveSyncPaused() ||
    !syncState.isConnected ||
    typeof navigator === "undefined" ||
    !navigator.onLine
  ) {
    return;
  }
  setTimeout(() => {
    if (snapshot.workspace && sameSyncContext({ workspace_id: snapshot.workspace.id, epoch: snapshot.epoch }, currentSyncRequest())) {
      void useSyncStore.getState().syncNow(true);
    }
  }, 1500);
}

let lastFocusSyncTimestamp = Date.now();
const FOCUS_SYNC_THROTTLE_MS = 180_000; // 3 minutos de throttle

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void checkAndApplyUpdate(false);
    const syncState = useSyncStore.getState();
    if (syncState.isConnected && !isDriveSyncPaused()) {
      void syncState.syncNow(true, true);
    }
  });

  window.addEventListener("focus", () => {
    void workspaceRecovery.onFocus();
    const now = Date.now();
    if (now - lastFocusSyncTimestamp < FOCUS_SYNC_THROTTLE_MS) {
      return;
    }
    const syncState = useSyncStore.getState();
    if (
      syncState.isConnected &&
      !isDriveSyncPaused() &&
      typeof navigator !== "undefined" &&
      navigator.onLine
    ) {
      lastFocusSyncTimestamp = now;
      void syncState.syncNow(true);
    }
  });
}
