import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { notification, pathIs, scrollToNovedades } from "./helpers";
import { navigateTo } from "../router";
import { PAGES } from "./consts";
import { useToastStore } from "../store/toastStore";
import { setListScroll } from "./listScroll";
import { prepareEditorsForRelaunch, runPreparedInstall, runPreparedRelaunch } from "./editorPersistence";
import { savePersistentPreferencesNow } from "./persistentPreferences";

import {
  compareVersions,
  type InstallationFormat,
  type InstallationInfo,
  type NativeUpdateInfo,
} from "./updaterVersion";

export type { InstallationFormat, InstallationInfo, NativeUpdateInfo };
export { compareVersions };


let isChecking = false;
let pendingRestartVersion: string | null = null;
let restartInProgress = false;

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
      notification("error", "No se pudo guardar todos los cambios. Revisa tus notas y vuelve a intentar el reinicio", undefined, 8000);
    }
  } catch (error) {
    console.error("Could not safely restart after update", error);
    notification("error", "No se pudo reiniciar Lyra. Tus cambios permanecen disponibles", undefined, 8000);
  } finally {
    restartInProgress = false;
  }
}

export function getIsCheckingUpdate(): boolean {
  return isChecking;
}

export function openNovedades(): void {
  if (pathIs(PAGES.list)) {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    setListScroll(y);
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
    console.error("Error al comprobar versión al inicio:", err);
  }
}


export async function checkAndApplyNativePackageUpdate(
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
        notification(
          "info",
          "Lyra está en la última versión disponible.",
          { label: "Ver novedades", onClick: openNovedades },
          5000
        );
      }
      return false;
    }

    if (getPendingRestartVersion() === update.version) {
      if (isManual) {
        notification(
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

    notification("info", `Actualizando a v${update.version}...`, undefined, 120000);

    const installed = await runPreparedInstall(
      () => prepareEditorsForRelaunch(),
      savePersistentPreferencesNow,
      async () => {
        const appRoot = document.getElementById("root");
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
      useToastStore.getState().clearToasts();
      notification(
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
    useToastStore.getState().clearToasts();
    notification(
      "success",
      "Actualización completada",
      { label: "Reiniciar Lyra", onClick: restartInstalledUpdate },
      8000
    );
    return true;
  } catch (error: any) {
    useToastStore.getState().clearToasts();
    const errorMsg = String(error?.message || error || "");
    const isCancelled =
      errorMsg.includes("cancelada por el usuario") ||
      errorMsg.includes("permisos no otorgados");

    if (isCancelled) {
      notification(
        "info",
        "Actualización cancelada o permisos de administrador no otorgados.",
        undefined,
        6000
      );
    } else if (isManual) {
      notification("error", `No se pudo actualizar Lyra: ${errorMsg}`, undefined, 7000);
    } else {
      console.warn("Comprobación automática de fondo falló:", errorMsg);
    }
    return false;
  }
}

export async function checkAndApplyRpmUpdate(isManual = false): Promise<void> {
  await checkAndApplyNativePackageUpdate("rpm", isManual);
}

export async function checkAndApplyDebUpdate(isManual = false): Promise<void> {
  await checkAndApplyNativePackageUpdate("deb", isManual);
}

export async function checkAndApplyUpdate(isManual = false): Promise<void> {
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
    return;
  }

  // 2. Prevenir comprobaciones concurrentes
  if (isChecking) {
    return;
  }

  // 3. Si no hay conexión a internet, salir silenciosamente (o avisar si fue clic manual)
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    if (isManual) {
      notification("info", "No hay conexión a internet.", undefined, 5000);
    }
    return;
  }

  isChecking = true;

  try {
    let installInfo: InstallationInfo | null = null;
    try {
      installInfo = await invoke<InstallationInfo>("get_installation_info");
    } catch (e) {
      console.warn("No se pudo obtener información de instalación:", e);
    }

    // Si es un paquete RPM o DEB que no cuenta con soporte nativo directo del actualizador oficial
    // (por ejemplo, cuando bundle_type no fue embebido o es una instalación personalizada en /usr)
    if (installInfo && !installInfo.supports_official_updater && (installInfo.format === "rpm" || installInfo.format === "deb")) {
      await checkAndApplyNativePackageUpdate(installInfo.format, isManual);
      return;
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
      return;
    }

    // Flujo prioritario: actualizador oficial de Tauri (AppImage, Windows, DEB/RPM con bundle_type)
    let checkedUpdate: Awaited<ReturnType<typeof check>> = null;
    try {
      const update = await check();
      checkedUpdate = update;
      if (!update) {
        if (isManual) {
          notification(
            "info",
            "Lyra está en la última versión disponible.",
            {
              label: "Ver novedades",
              onClick: openNovedades,
            },
            5000
          );
        }
        return;
      }

      // Si la versión detectada ya está lista para reiniciar
      if (getPendingRestartVersion() === update.version) {
        if (isManual) {
          notification(
            "success",
            `La versión v${update.version} está lista para usar`,
            {
              label: "Reiniciar Lyra",
              onClick: restartInstalledUpdate,
            },
            8000
          );
        }
        return;
      }

      notification("info", `Actualizando a v${update.version}...`, undefined, 120000);

      if (update.body) {
        try {
          window.localStorage.setItem("lyra_release_notes", update.body);
          window.localStorage.setItem("lyra_release_version", update.version);
        } catch {}
      }

      await update.download(event => {
        if (event.event === "Finished") {
          console.log("Descarga de actualización finalizada exitosamente.");
        }
      });

      const installed = await runPreparedInstall(
        () => prepareEditorsForRelaunch(),
        savePersistentPreferencesNow,
        async () => {
          const appRoot = document.getElementById("root");
          const wasInert = appRoot?.inert ?? false;
          if (appRoot) appRoot.inert = true;
          try {
            window.localStorage.setItem("lyra_just_updated", "true");
            window.localStorage.setItem("lyra_pending_install_version", update.version);
            await update.install();
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
        useToastStore.getState().clearToasts();
        notification("error", "No se pudo guardar todos los cambios. Revisa tus notas y vuelve a intentar la actualización", undefined, 8000);
        return;
      }

      pendingRestartVersion = update.version;
      try {
        window.sessionStorage.setItem("lyra_pending_restart_version", update.version);
      } catch {}

      useToastStore.getState().clearToasts();
      notification(
        "success",
        "Actualización completada",
        {
          label: "Reiniciar Lyra",
          onClick: restartInstalledUpdate,
        },
        8000
      );
    } catch (officialError: any) {
      if (checkedUpdate) {
        try { await checkedUpdate.close(); } catch {}
        checkedUpdate = null;
      }

      const errorMsg = String(officialError?.message || officialError || "");
      const isPermission =
        errorMsg.includes("os error 13") ||
        errorMsg.includes("Permission denied") ||
        errorMsg.includes("permission denied");

      // Si el actualizador oficial falló en RPM/DEB (por ejemplo falta de permisos o fallo de dpkg/rpm), intentar fallback nativo
      if (installInfo && (installInfo.format === "rpm" || installInfo.format === "deb")) {
        console.warn("Actualizador oficial falló en instalación empaquetada, probando gestor nativo:", officialError);
        const handled = await checkAndApplyNativePackageUpdate(installInfo.format, isManual);
        if (handled) return;
      }

      useToastStore.getState().clearToasts();

      const isNotFound =
        errorMsg.includes("Could not fetch a valid release JSON") ||
        errorMsg.includes("404") ||
        errorMsg.includes("status 404");

      if (isNotFound) {
        if (isManual) {
          notification(
            "info",
            "Lyra está en la última versión disponible.",
            {
              label: "Ver novedades",
              onClick: openNovedades,
            },
            5000
          );
        }
      } else if (isPermission) {
        notification(
          "error",
          "No se pudo instalar la actualización por falta de permisos administrativos.",
          undefined,
          7000
        );
      } else if (isManual) {
        notification("error", `No se pudo actualizar Lyra: ${errorMsg}`, undefined, 6000);
      } else {
        console.warn("Comprobación automática de fondo falló silenciosamente:", errorMsg);
      }
    } finally {
      if (checkedUpdate) {
        try { await checkedUpdate.close(); } catch {}
      }
    }
  } finally {
    isChecking = false;
  }
}
