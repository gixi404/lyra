import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

let hasShownWindow = false;

export async function showAppWindow(): Promise<void> {
  if (hasShownWindow) return;
  hasShownWindow = true;
  try {
    await invoke("show_main_window");
  } catch {
    try {
      const appWindow = getCurrentWebviewWindow();
      await appWindow.show();
      await appWindow.setFocus();
    } catch {
      // Outside Tauri / Web dev
    }
  }
}

export function triggerWindowReady(): void {
  // En WebKitGTK / Wayland, requestAnimationFrame se pausa si la ventana no es visible.
  // setTimeout se ejecuta puntualmente, permitiendo que la ventana se muestre en cuanto
  // React monta el DOM, evitando esperas innecesarias o el fallback por timeout.
  setTimeout(() => {
    void showAppWindow();
  }, 10);
}
