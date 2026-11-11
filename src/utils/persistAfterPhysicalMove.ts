import { notification } from "./helpers.ts";
import { logger } from "./logger.ts";
import { savePersistentPreferencesNow } from "./persistentPreferences.ts";
import { configStore } from "../store/configStore.ts";
import type { FolderOrder } from "./folderTree.ts";

/**
 * Persiste de inmediato el orden del explorador tras un movimiento físico
 * confirmado (mover una nota o una carpeta). Cancela cualquier escritura
 * debounced pendiente y escribe el snapshot actual en .preferences.json antes
 * de devolver el control, para que un cierre inmediato no pierda el orden.
 *
 * Un reordenamiento visual puro (sin movimiento físico) NO debe llamar esta
 * función; esos casos conservan el debounce habitual.
 *
 * Devuelve `true` si el guardado se completó. Si el guardado falla, el
 * movimiento ya se ejecutó y localStorage sigue siendo coherente: se
 * registran el error y se avisa al usuario, pero no se revierte nada.
 */
export async function persistOrderAfterPhysicalMove(
  orderKey: "folderOrder" | "fileOrder",
  order: FolderOrder,
): Promise<boolean> {
  try {
    window.localStorage.setItem(orderKey, JSON.stringify(order));
    configStore.getState().bumpPrefTick();
    await savePersistentPreferencesNow();
    return true;
  } catch (error) {
    logger.error("No se pudo guardar la preferencia de orden en disco:", error);
    notification("error", "El archivo se movió, pero no se pudo guardar la colocación");
    return false;
  }
}
