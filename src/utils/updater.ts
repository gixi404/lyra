import { check } from "@tauri-apps/plugin-updater";
import { notification } from "./helpers";
import { navigateTo } from "../router";
import { PAGES } from "./consts";

let isChecking = false;

export async function checkAndApplyUpdate(isManual = false): Promise<void> {
  if (isChecking) return;

  // Si no hay conexión a internet, salir silenciosamente (o avisar si fue clic manual)
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    if (isManual) {
      notification("info", "No hay conexión a internet.");
    }
    return;
  }

  isChecking = true;

  try {
    const update = await check();
    if (!update) {
      if (isManual) {
        notification("info", "Lyra está en la última versión disponible.");
      }
      return;
    }

    // Actualización disponible: notificar "Actualizando..." y descargar/instalar
    notification("info", "Actualizando...", undefined, 12000);

    // Guardar notas de la versión en almacenamiento local para mostrarlas en Preferencias
    if (update.body) {
      try {
        window.localStorage.setItem("lyra_release_notes", update.body);
        window.localStorage.setItem("lyra_release_version", update.version);
      } catch {}
    }

    // Descarga e instala en segundo plano
    await update.downloadAndInstall();

    // Notificar al usuario con enlace directo y clicable a las novedades
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
        },
      },
      10000
    );
  } catch (error: any) {
    const errorMsg = String(error?.message || error || "");
    const isNotFound =
      errorMsg.includes("Could not fetch a valid release JSON") ||
      errorMsg.includes("404") ||
      errorMsg.includes("status 404");

    if (isNotFound) {
      if (isManual) {
        notification("info", "Lyra está en la última versión disponible.");
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
          "Sin permisos para sobrescribir el ejecutable del sistema (/usr/bin). Actualiza vía DNF o usa la versión AppImage."
        );
      } else if (isManual) {
        notification("error", `Error al actualizar: ${errorMsg}`);
      }
    }
  } finally {
    isChecking = false;
  }
}
