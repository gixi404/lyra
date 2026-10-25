import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { notification } from "./helpers";

let isChecking = false;

export async function checkAndApplyUpdate(isManual = false): Promise<void> {
  if (isChecking) return;
  isChecking = true;

  try {
    const update = await check();
    if (!update) {
      if (isManual) {
        notification("info", "Lyra está en la última versión disponible.");
      }
      return;
    }

    if (!isManual) {
      // Notificación discreta al iniciar: no reiniciar abruptamente mientras el usuario escribe
      notification("info", `Nueva versión ${update.version} disponible. Actualízala desde Preferencias.`);
      return;
    }

    notification("info", `Nueva versión ${update.version} encontrada. Descargando...`);

    // Descarga e instala en segundo plano
    await update.downloadAndInstall();

    // Notificar al usuario y reiniciar
    notification("success", `Versión ${update.version} lista. Reiniciando Lyra...`);

    setTimeout(async () => {
      try {
        await relaunch();
      } catch (err) {
        console.error("Error al reiniciar Lyra tras actualizar:", err);
      }
    }, 2000);
  } catch (error: any) {
    const errorMsg = String(error?.message || error || "");
    const isNotFound =
      errorMsg.includes("Could not fetch a valid release JSON") ||
      errorMsg.includes("404") ||
      errorMsg.includes("status 404");

    if (isManual) {
      if (isNotFound) {
        notification("info", "Lyra está en la última versión disponible.");
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
        } else {
          notification("error", `Error al actualizar: ${errorMsg}`);
        }
      }
    }
  } finally {
    isChecking = false;
  }
}
