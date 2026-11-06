import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { PAGES } from "./consts.ts";
import { useToastStore, type ToastAction, type ToastType } from "../store/toastStore.ts";
import { getScrollPos, setListScroll } from "./listScroll.ts";
import { pathIs, scrollToNovedades, navigateTo } from "./navigation.ts";
import { prepareEditorsForRelaunch, runPreparedInstall, runPreparedRelaunch } from "./editorPersistence.ts";
import { savePersistentPreferencesNow } from "./persistentPreferences.ts";

import {
  compareVersions,
  categorizeUpdateError,
  isUpdateCancellation,
  type InstallationFormat,
  type InstallationInfo,
  type NativeUpdateInfo,
  type UpdateFailureCategory,
  type UpdateFailureInfo,
} from "./updaterVersion.ts";
import { logger } from "./logger.ts";

function notification(
  type: ToastType,
  msg: string,
  action?: ToastAction,
  durationMs?: number
): string {
  return useToastStore.getState().addToast(type, msg, action, durationMs);
}

export type {
  InstallationFormat,
  InstallationInfo,
  NativeUpdateInfo,
  UpdateFailureCategory,
  UpdateFailureInfo,
};
export { compareVersions, categorizeUpdateError, isUpdateCancellation };

let isChecking = false;
let pendingRestartVersion: string | null = null;
let restartInProgress = false;
let activeUpdaterToastId: string | null = null;

export function clearUpdaterToast(): void {
  if (activeUpdaterToastId) {
    useToastStore.getState().removeToast(activeUpdaterToastId);
    activeUpdaterToastId = null;
  }
}

export function updaterNotification(
  type: ToastType,
  msg: string,
  action?: ToastAction,
  durationMs?: number
): string {
  clearUpdaterToast();
  const id = useToastStore.getState().addToast(type, msg, action, durationMs);
  activeUpdaterToastId = id;
  return id;
}

export async function restartInstalledUpdate(): Promise<void> {
  if (restartInProgress) return;
  restartInProgress = true;
  try {
    const restarted = await runPreparedRelaunch(
      () => prepareEditorsForRelaunch(),
      savePersistentPreferencesNow,
      relaunch,
    );
    if (!restarted) {
      updaterNotification("error", "No se pudo guardar todos los cambios. Revisa tus notas y vuelve a intentar el reinicio", undefined, 8000);
    }
  } catch (error) {
    logger.error("Could not safely restart after update", error);
    updaterNotification("error", "No se pudo reiniciar Lyra. Tus cambios permanecen disponibles", undefined, 8000);
  } finally {
    restartInProgress = false;
  }
}

export function getIsCheckingUpdate(): boolean {
  return isChecking;
}

export function openNovedades(): void {
  if (typeof window === "undefined") return;
  try {
    if (pathIs(PAGES.list)) {
      setListScroll(getScrollPos());
    }

    if (pathIs(PAGES.preferences)) {
      try {
        window.sessionStorage.removeItem("scroll_to_novedades");
      } catch {}
      scrollToNovedades();
    } else {
      try {
        window.sessionStorage.setItem("scroll_to_novedades", "true");
      } catch {}
      navigateTo(PAGES.preferences);
    }
  } catch (e) {
    logger.error("Error al abrir novedades:", e);
  }
}

export function getPendingRestartVersion(): string | null {
  if (pendingRestartVersion) return pendingRestartVersion;
  try {
    return window.sessionStorage.getItem("lyra_pending_restart_version");
  } catch {
    return null;
  }
}

export async function notifyIfJustUpdated(): Promise<void> {
  try {
    const currentVersion = await getVersion();
    const lastSeenVersion = window.localStorage.getItem("lyra_last_seen_version");
    const wasJustUpdated = window.localStorage.getItem("lyra_just_updated") === "true";
    const expectedVersion = window.localStorage.getItem("lyra_pending_install_version");
    const isNewVersion = Boolean(lastSeenVersion && lastSeenVersion !== currentVersion);

    // Solo notificar si realmente hubo un cambio de versión previo o se marcó la bandera de reinicio
    const shouldNotify = (wasJustUpdated && (!expectedVersion || expectedVersion === currentVersion)) || isNewVersion;

    if (shouldNotify) {
      window.localStorage.removeItem("lyra_just_updated");
      window.localStorage.removeItem("lyra_pending_install_version");
      try {
        window.sessionStorage.removeItem("lyra_pending_restart_version");
      } catch {}
      pendingRestartVersion = null;
      window.localStorage.setItem("lyra_last_seen_version", currentVersion);

      notification(
        "success",
        "Actualización completada",
        {
          label: "Ver novedades",
          onClick: openNovedades,
        },
        8000
      );
    } else if (!lastSeenVersion) {
      window.localStorage.setItem("lyra_last_seen_version", currentVersion);
    } else if (wasJustUpdated && expectedVersion !== currentVersion) {
      window.localStorage.removeItem("lyra_just_updated");
      window.localStorage.removeItem("lyra_pending_install_version");
    }
  } catch (err) {
    logger.error("Error al comprobar versión al inicio:", err);
  }
}


async function executeNativePackageUpdate(
  format: "rpm" | "deb",
  isManual = false
): Promise<boolean> {
  try {
    const currentVersion = await getVersion();
    const update = await invoke<NativeUpdateInfo | null>("check_native_update", {
      format,
      currentVersion,
    });

    if (!update || compareVersions(update.version, currentVersion) <= 0) {
      if (isManual) {
        updaterNotification(
          "info",
          "Lyra está en la última versión disponible.",
          { label: "Ver novedades", onClick: openNovedades },
          5000
        );
      }
      return true;
    }

    if (getPendingRestartVersion() === update.version) {
      if (isManual) {
        updaterNotification(
          "success",
          `La versión v${update.version} está lista para usar`,
          { label: "Reiniciar Lyra", onClick: restartInstalledUpdate },
          8000
        );
      }
      return true;
    }

    if (update.notes) {
      try {
        window.localStorage.setItem("lyra_release_notes", update.notes);
        window.localStorage.setItem("lyra_release_version", update.version);
      } catch {}
    }

    // Comprobación en segundo plano (automática): no solicitar elevación de privilegios de forma autónoma.
    // Solo notificar al usuario para que decida actualizar con un clic explícito.
    if (!isManual) {
      updaterNotification(
        "info",
        `Nueva versión v${update.version} disponible`,
        {
          label: "Actualizar ahora",
          onClick: () => {
            void checkAndApplyNativePackageUpdate(format, true);
          },
        },
        10000
      );
      return true;
    }

    // Flujo manual explícito: reemplazar cualquier notificación previa del actualizador por el progreso
    updaterNotification("info", `Actualizando a v${update.version}...`, undefined, 120000);

    const installed = await runPreparedInstall(
      () => prepareEditorsForRelaunch(),
      savePersistentPreferencesNow,
      async () => {
        const appRoot = typeof document !== "undefined" ? document.getElementById("root") : null;
        const wasInert = appRoot?.inert ?? false;
        if (appRoot) appRoot.inert = true;
        try {
          window.localStorage.setItem("lyra_just_updated", "true");
          window.localStorage.setItem("lyra_pending_install_version", update.version);
          await invoke("apply_native_update", {
            url: update.url,
            signature: update.signature,
            format,
          });
        } catch (error) {
          window.localStorage.removeItem("lyra_just_updated");
          window.localStorage.removeItem("lyra_pending_install_version");
          throw error;
        } finally {
          if (appRoot) appRoot.inert = wasInert;
        }
      }
    );

    if (!installed) {
      updaterNotification(
        "error",
        "No se pudo guardar todos los cambios. Revisa tus notas y vuelve a intentar la actualización",
        undefined,
        8000
      );
      return false;
    }

    pendingRestartVersion = update.version;
    try {
      window.sessionStorage.setItem("lyra_pending_restart_version", update.version);
    } catch {}
    updaterNotification(
      "success",
      "Actualización completada",
      { label: "Reiniciar Lyra", onClick: restartInstalledUpdate },
      8000
    );
    return true;
  } catch (error) {
    clearUpdaterToast();
    const failure = categorizeUpdateError(error);

    if (failure.category === "cancelled") {
      updaterNotification(
        "info",
        "Actualización cancelada",
        undefined,
        5000
      );
    } else if (failure.category === "auth_denied") {
      updaterNotification(
        "error",
        failure.message,
        undefined,
        7000
      );
    } else if (isManual) {
      updaterNotification(
        "error",
        `No se pudo actualizar Lyra: ${failure.message}`,
        undefined,
        7000
      );
    } else {
      logger.warn("Comprobación automática de fondo falló:", failure.message);
    }
    return false;
  }
}

export async function checkAndApplyNativePackageUpdate(
  format: "rpm" | "deb",
  isManual = false
): Promise<boolean> {
  if (isChecking) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (isManual) {
      notification("info", "No hay conexión a internet.", undefined, 5000);
    }
    return false;
  }

  isChecking = true;
  try {
    return await executeNativePackageUpdate(format, isManual);
  } finally {
    isChecking = false;
  }
}

export async function checkAndApplyRpmUpdate(isManual = false): Promise<void> {
  await checkAndApplyNativePackageUpdate("rpm", isManual);
}

export async function checkAndApplyDebUpdate(isManual = false): Promise<void> {
  await checkAndApplyNativePackageUpdate("deb", isManual);
}

export interface UpdateLike {
  version: string;
  body?: string;
  download?: (onEvent?: (event: { event: string; data?: unknown }) => void) => Promise<void>;
  install?: () => Promise<void>;
  close?: () => Promise<void>;
}

export interface CheckAndApplyUpdateOptions {
  checkUpdaterPlugin?: () => Promise<UpdateLike | Update | null>;
  getInstallInfo?: () => Promise<InstallationInfo | null>;
  onNotification?: (type: ToastType, msg: string, action?: ToastAction, durationMs?: number) => string;
  savePreferences?: () => Promise<unknown>;
}

export async function checkAndApplyUpdate(
  isManual = false,
  options?: CheckAndApplyUpdateOptions
): Promise<boolean> {
  const notify = options?.onNotification ?? updaterNotification;

  // 1. Si la versión ya fue descargada e instalada en esta sesión y espera reinicio, NO volver a descargar
  const pendingVersion = getPendingRestartVersion();
  if (pendingVersion) {
    if (isManual) {
      notification(
        "success",
        `La versión v${pendingVersion} está lista para usar`,
        {
          label: "Reiniciar Lyra",
          onClick: restartInstalledUpdate,
        },
        8000
      );
    }
    return true;
  }

  // 2. Prevenir comprobaciones concurrentes
  if (isChecking) {
    return false;
  }

  // 3. Si no hay conexión a internet, salir silenciosamente (o avisar si fue clic manual)
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (isManual) {
      notification("info", "No hay conexión a internet.", undefined, 5000);
    }
    return false;
  }

  isChecking = true;

  try {
    let installInfo: InstallationInfo | null = null;
    try {
      installInfo = options?.getInstallInfo
        ? await options.getInstallInfo()
        : await invoke<InstallationInfo>("get_installation_info");
    } catch (e) {
      logger.warn("No se pudo obtener información de instalación:", e);
    }

    // Para RPM y DEB: usar exclusivamente el gestor de paquetes nativo, sin intervención del plugin de Tauri
    if (installInfo && (installInfo.format === "rpm" || installInfo.format === "deb")) {
      return await executeNativePackageUpdate(installInfo.format, isManual);
    }

    if (installInfo?.format === "standalone") {
      if (isManual) {
        notification(
          "info",
          "Lyra se está ejecutando en modo independiente. Descarga las actualizaciones desde GitHub Releases.",
          {
            label: "Ver novedades",
            onClick: openNovedades,
          },
          7000
        );
      }
      return true;
    }

    // Flujo para formatos soportados por Tauri oficial (AppImage, Windows, macOS)
    let checkedUpdate: UpdateLike | Update | null = null;
    try {
      const update = options?.checkUpdaterPlugin
        ? await options.checkUpdaterPlugin()
        : await check();
      checkedUpdate = update;
      if (!update) {
        if (isManual) {
          notify(
            "info",
            "Lyra está en la última versión disponible.",
            {
              label: "Ver novedades",
              onClick: openNovedades,
            },
            5000
          );
        }
        return true;
      }

      // Si la versión detectada ya está lista para reiniciar
      if (getPendingRestartVersion() === update.version) {
        if (isManual) {
          notify(
            "success",
            `La versión v${update.version} está lista para usar`,
            {
              label: "Reiniciar Lyra",
              onClick: restartInstalledUpdate,
            },
            8000
          );
        }
        return true;
      }

      if (update.body) {
        try {
          window.localStorage.setItem("lyra_release_notes", update.body);
          window.localStorage.setItem("lyra_release_version", update.version);
        } catch {}
      }

      // Comprobación en segundo plano (automática): no descargar ni instalar de forma autónoma.
      // Solo notificar al usuario para que decida actualizar con un clic explícito.
      if (!isManual) {
        notify(
          "info",
          `Nueva versión v${update.version} disponible`,
          {
            label: "Actualizar ahora",
            onClick: () => {
              void checkAndApplyUpdate(true, options);
            },
          },
          10000
        );
        return true;
      }

      notify("info", `Actualizando a v${update.version}...`, undefined, 120000);

      if (update.download) {
        await update.download((event: { event: string; data?: unknown }) => {
          if (event.event === "Finished") {
            // trace log removed
          }
        });
      }

      const installed = await runPreparedInstall(
        () => prepareEditorsForRelaunch(),
        async () => {
          if (options?.savePreferences) {
            await options.savePreferences();
          } else {
            await savePersistentPreferencesNow();
          }
        },
        async () => {
          const appRoot = typeof document !== "undefined" ? document.getElementById("root") : null;
          const wasInert = appRoot?.inert ?? false;
          if (appRoot) appRoot.inert = true;
          try {
            window.localStorage.setItem("lyra_just_updated", "true");
            window.localStorage.setItem("lyra_pending_install_version", update.version);
            if (update.install) {
              await update.install();
            }
          } catch (error) {
            window.localStorage.removeItem("lyra_just_updated");
            window.localStorage.removeItem("lyra_pending_install_version");
            throw error;
          } finally {
            if (appRoot) appRoot.inert = wasInert;
          }
        },
      );

      if (!installed) {
        updaterNotification("error", "No se pudo guardar todos los cambios. Revisa tus notas y vuelve a intentar la actualización", undefined, 8000);
        return false;
      }

      pendingRestartVersion = update.version;
      try {
        window.sessionStorage.setItem("lyra_pending_restart_version", update.version);
      } catch {}

      updaterNotification(
        "success",
        "Actualización completada",
        {
          label: "Reiniciar Lyra",
          onClick: restartInstalledUpdate,
        },
        8000
      );
      return true;
    } catch (officialError) {
      if (checkedUpdate) {
        try { await checkedUpdate.close?.(); } catch {}
        checkedUpdate = null;
      }

      clearUpdaterToast();

      const failure = categorizeUpdateError(officialError);

      if (failure.category === "cancelled") {
        updaterNotification("info", "Actualización cancelada", undefined, 5000);
        return false;
      }

      if (failure.category === "auth_denied") {
        updaterNotification("error", failure.message, undefined, 7000);
        return false;
      }

      const errorMsg = officialError instanceof Error ? officialError.message : String(officialError || "");
      const isNotFound =
        errorMsg.includes("Could not fetch a valid release JSON") ||
        errorMsg.includes("404") ||
        errorMsg.includes("status 404");

      if (isNotFound) {
        if (isManual) {
          updaterNotification(
            "info",
            "Lyra está en la última versión disponible.",
            {
              label: "Ver novedades",
              onClick: openNovedades,
            },
            5000
          );
        }
        return true;
      } else if (isManual) {
        updaterNotification("error", `No se pudo actualizar Lyra: ${failure.message}`, undefined, 6000);
      } else {
        logger.warn("Comprobación automática de fondo falló silenciosamente:", errorMsg);
      }
      return false;
    } finally {
      if (checkedUpdate) {
        try { await checkedUpdate.close?.(); } catch {}
      }
    }
  } finally {
    isChecking = false;
  }
}
