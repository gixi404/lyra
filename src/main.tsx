import { RouterProvider } from "react-router-dom";
import { StrictMode, Suspense } from "react";
import Toast from "./components/Toast.tsx";
import PendingAuthorizationDialog from "./components/PendingAuthorizationDialog.tsx";
import "./styles.css";
import { type Container, createRoot } from "react-dom/client";
import { checkAndApplyUpdate, notifyIfJustUpdated } from "./utils/updater.ts";
import { initStartupPreferences } from "./utils/persistentPreferences.ts";
import { initializeArchiveState } from "./utils/archiveState.ts";
import { initRecoveryNotifier } from "./utils/recoveryNotifier.ts";
import { useSyncStore } from "./store/syncStore.ts";
import { configStore } from "./store/configStore.ts";
import { router } from "./router.tsx";
import { initExternalFileListener } from "./utils/fileImporter.ts";
import { logger } from "./utils/logger.ts";
import { reconcilePendingDeletedCleanup } from "./utils/deletedPathCleanup.ts";
import { GDRIVE_REMOTE_SYNC_ENABLED } from "./utils/gdriveRemote.ts";
import { hydrateSortOptionFromStorage } from "./store/searchStore.ts";

const root = document.getElementById("root") as Container;

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
  const initialBg = isDark ? "#101010" : "#F7F8FA";
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
    <Suspense fallback={<div className="w-full min-h-screen bg-[#101010] light:bg-[#F7F8FA]" />}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </Suspense>
    <Toast />
    {GDRIVE_REMOTE_SYNC_ENABLED ? <PendingAuthorizationDialog /> : null}
  </StrictMode>
);


// Inicializar notificador y drenado de recuperaciones de archivos temporales
void initRecoveryNotifier();

// Inicializar escucha y drenado de archivos abiertos desde el sistema operativo
void initExternalFileListener();

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

// Inicializar estado local y, solo si está habilitado, Google Drive remoto.
void (async () => {
  try {
    await initStartupPreferences();
    hydrateSortOptionFromStorage();
    // Reconciliación tras reinicio: limpiar prefs de eliminaciones completadas pendientes,
    // sin borrar prefs de elementos nuevos que reutilicen rutas antiguas.
    await reconcilePendingDeletedCleanup();
    await initializeArchiveState();
    if (GDRIVE_REMOTE_SYNC_ENABLED) {
      await useSyncStore.getState().fetchStatus();
      const syncState = useSyncStore.getState();
      if (
        syncState.isConnected &&
        typeof navigator !== "undefined" &&
        navigator.onLine
      ) {
        setTimeout(() => {
          void useSyncStore.getState().syncNow(true);
        }, 1500);
      }
    }
  } catch (error) {
    logger.error("Could not initialize archive state", error);
  }
})();

let lastFocusSyncTimestamp = Date.now();
const FOCUS_SYNC_THROTTLE_MS = 180_000; // 3 minutos de throttle

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void checkAndApplyUpdate(false);
    if (!GDRIVE_REMOTE_SYNC_ENABLED) return;
    const syncState = useSyncStore.getState();
    if (syncState.isConnected) {
      void syncState.syncNow(true, true);
    }
  });

  window.addEventListener("focus", () => {
    void initRecoveryNotifier();
    if (!GDRIVE_REMOTE_SYNC_ENABLED) return;
    const now = Date.now();
    if (now - lastFocusSyncTimestamp < FOCUS_SYNC_THROTTLE_MS) {
      return;
    }
    const syncState = useSyncStore.getState();
    if (
      syncState.isConnected &&
      typeof navigator !== "undefined" &&
      navigator.onLine
    ) {
      lastFocusSyncTimestamp = now;
      void syncState.syncNow(true);
    }
  });
}
