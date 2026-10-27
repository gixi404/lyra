import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { notification, pathIs, scrollToNovedades } from "./helpers";
import { navigateTo } from "../router";
import { PAGES } from "./consts";
import { useToastStore } from "../store/toastStore";
import { setListScroll } from "./listScroll";

let isChecking = false;
let pendingRestartVersion: string | null = null;

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
    const isNewVersion = Boolean(lastSeenVersion && lastSeenVersion !== currentVersion);

    // Solo notificar si realmente hubo un cambio de versión previo o se marcó la bandera de reinicio
    const shouldNotify = wasJustUpdated || isNewVersion;

    if (shouldNotify) {
      window.localStorage.removeItem("lyra_just_updated");
      try {
        window.sessionStorage.removeItem("lyra_pending_restart_version");
      } catch {}
      pendingRestartVersion = null;
      window.localStorage.setItem("lyra_last_seen_version", currentVersion);

      notification(
        "success",
        "Actualización terminada.",
        {
          label: "Ver novedades",
          onClick: openNovedades,
        },
        8000
      );
    } else if (!lastSeenVersion) {
      window.localStorage.setItem("lyra_last_seen_version", currentVersion);
    }
  } catch (err) {
    console.error("Error al comprobar versión al inicio:", err);
  }
}

export async function checkAndApplyUpdate(isManual = false): Promise<void> {
  // 1. Si la versión ya fue descargada e instalada en esta sesión y espera reinicio, NO volver a descargar
  const pendingVersion = getPendingRestartVersion();
  if (pendingVersion) {
    if (isManual) {
      notification(
        "success",
        `La versión v${pendingVersion} ya está descargada e instalada.`,
        {
          label: "Reiniciar para ver novedades",
          onClick: async () => {
            try {
              await relaunch();
            } catch (err) {
              console.error("Error al reiniciar la aplicación automáticamente:", err);
              notification(
                "error",
                "No se pudo reiniciar automáticamente. Por favor, cierra y vuelve a abrir Lyra.",
                undefined,
                8000
              );
            }
          },
        },
        8000
      );
    }
    return;
  }

  // 2. Prevenir comprobaciones concurrentes
  if (isChecking) {
    if (isManual) {
      notification("info", "Ya se está comprobando o descargando una actualización...", undefined, 4000);
    }
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
    const update = await check();
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

    // Si la actualización detectada coincide con la que ya instalamos en memoria
    if (getPendingRestartVersion() === update.version) {
      if (isManual) {
        notification(
          "success",
          `La versión v${update.version} ya está descargada e instalada.`,
          {
            label: "Reiniciar para ver novedades",
            onClick: async () => {
              try {
                await relaunch();
              } catch (err) {
                console.error("Error al reiniciar la aplicación automáticamente:", err);
                notification(
                  "error",
                  "No se pudo reiniciar automáticamente. Por favor, cierra y vuelve a abrir Lyra.",
                  undefined,
                  8000
                );
              }
            },
          },
          8000
        );
      }
      return;
    }

    // 4. Notificar inicio de descarga de la nueva versión
    notification("info", `Actualizando a v${update.version}...`, undefined, 120000);

    // Guardar notas de la versión en almacenamiento local para mostrarlas en Preferencias
    if (update.body) {
      try {
        window.localStorage.setItem("lyra_release_notes", update.body);
        window.localStorage.setItem("lyra_release_version", update.version);
      } catch {}
    }

    // 5. Descarga e instala en segundo plano
    await update.downloadAndInstall(event => {
      if (event.event === "Finished") {
        console.log("Descarga de actualización finalizada exitosamente.");
      }
    });

    // 6. Marcar que la actualización ya fue instalada en disco para evitar descargas infinitas
    pendingRestartVersion = update.version;
    try {
      window.sessionStorage.setItem("lyra_pending_restart_version", update.version);
    } catch {}

    // Marcar bandera para que al volver a abrir la app se muestre el toast de novedades
    try {
      window.localStorage.setItem("lyra_just_updated", "true");
    } catch {}

    // Remover el toast de "Actualizando..."
    useToastStore.getState().clearToasts();

    // 7. Notificar "Actualización terminada." con acción para reiniciar (duración: 8 segundos)
    notification(
      "success",
      "Actualización terminada.",
      {
        label: "Reiniciar para ver novedades",
        onClick: async () => {
          try {
            await relaunch();
          } catch (err) {
            console.error("Error al reiniciar la aplicación automáticamente:", err);
            notification(
              "error",
              "No se pudo reiniciar automáticamente. Por favor, cierra y vuelve a abrir Lyra.",
              undefined,
              8000
            );
          }
        },
      },
      8000
    );
  } catch (error: any) {
    useToastStore.getState().clearToasts();

    const errorMsg = String(error?.message || error || "");
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
    } else {
      console.error("Error al comprobar/instalar actualización:", error);
      const isPermission =
        errorMsg.includes("os error 13") ||
        errorMsg.includes("Permission denied") ||
        errorMsg.includes("permission denied");

      if (isPermission) {
        notification(
          "error",
          "Sin permisos para sobrescribir el ejecutable del sistema (/usr/bin). Actualiza vía DNF o usa la versión AppImage.",
          undefined,
          7000
        );
      } else if (isManual) {
        notification("error", `Error al actualizar: ${errorMsg}`, undefined, 6000);
      } else {
        // En revisiones automáticas de fondo, silenciar errores de red temporales para no molestar
        console.warn("Comprobación automática de fondo falló silenciosamente:", errorMsg);
      }
    }
  } finally {
    isChecking = false;
  }
}
