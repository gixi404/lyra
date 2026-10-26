import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { notification, scrollToNovedades } from "./helpers";
import { navigateTo } from "../router";
import { PAGES } from "./consts";
import { useToastStore } from "../store/toastStore";

let isChecking = false;

export async function notifyIfJustUpdated(): Promise<void> {
  try {
    const currentVersion = await getVersion();
    const lastSeenVersion = window.localStorage.getItem("lyra_last_seen_version");
    const wasJustUpdated = window.localStorage.getItem("lyra_just_updated") === "true";

    // Si hay datos previos de la app y la versión cambió, o si se marcó la bandera de actualización:
    const hasExistingData =
      window.localStorage.getItem("theme") !== null ||
      window.localStorage.getItem("font") !== null ||
      window.localStorage.getItem("files") !== null ||
      window.localStorage.getItem("paper") !== null;

    const isNewVersion = lastSeenVersion !== currentVersion;
    const shouldNotify = (lastSeenVersion && isNewVersion) || wasJustUpdated || (!lastSeenVersion && hasExistingData);

    if (shouldNotify) {
      window.localStorage.removeItem("lyra_just_updated");
      window.localStorage.setItem("lyra_last_seen_version", currentVersion);

      notification(
        "success",
        "Actualización terminada.",
        {
          label: "Ver novedades",
          onClick: () => {
            try {
              window.sessionStorage.setItem("scroll_to_novedades", "true");
            } catch {}
            navigateTo(PAGES.preferences);
            scrollToNovedades();
          },
        },
        7000
      );
    } else if (!lastSeenVersion) {
      window.localStorage.setItem("lyra_last_seen_version", currentVersion);
    }
  } catch (err) {
    console.error("Error al comprobar versión al inicio:", err);
  }
}

export async function checkAndApplyUpdate(isManual = false): Promise<void> {
  if (isChecking) return;

  // Si no hay conexión a internet, salir silenciosamente (o avisar si fue clic manual)
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
            onClick: () => {
              try {
                window.sessionStorage.setItem("scroll_to_novedades", "true");
              } catch {}
              navigateTo(PAGES.preferences);
              scrollToNovedades();
            },
          },
          5000
        );
      }
      return;
    }

    // 1. Notificar "Actualizando..."
    notification("info", "Actualizando...", undefined, 120000);

    // Guardar notas de la versión en almacenamiento local para mostrarlas en Preferencias
    if (update.body) {
      try {
        window.localStorage.setItem("lyra_release_notes", update.body);
        window.localStorage.setItem("lyra_release_version", update.version);
      } catch {}
    }

    // Descarga e instala en segundo plano
    await update.downloadAndInstall();

    // Marcar bandera para que al volver a abrir la app se muestre el toast de novedades
    try {
      window.localStorage.setItem("lyra_just_updated", "true");
    } catch {}

    // Remover el toast de "Actualizando..."
    useToastStore.getState().clearToasts();

    // 2. Notificar "Actualización terminada." con acción para reiniciar y ver novedades
    notification(
      "success",
      "Actualización terminada.",
      {
        label: "Reiniciar para ver novedades",
        onClick: async () => {
          try {
            await relaunch();
          } catch (err) {
            console.error("Error al reiniciar la aplicación:", err);
          }
        },
      },
      30000
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
            onClick: () => {
              try {
                window.sessionStorage.setItem("scroll_to_novedades", "true");
              } catch {}
              navigateTo(PAGES.preferences);
              scrollToNovedades();
            },
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
          5000
        );
      } else {
        notification("error", `Error al actualizar: ${errorMsg}`, undefined, 5000);
      }
    }
  } finally {
    isChecking = false;
  }
}
