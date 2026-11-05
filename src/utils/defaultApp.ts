import { invoke } from "@tauri-apps/api/core";

export type DefaultAppOutcome =
  | { type: "already_default"; message: string }
  | { type: "configured_automatically"; configured_mimes: string[]; message: string }
  | { type: "partially_configured"; configured_mimes: string[]; failed_mimes: string[]; message: string }
  | { type: "manual_settings_opened"; message: string }
  | { type: "instructions_needed"; reason: string }
  | { type: "error"; message: string };

export interface DefaultAppSettingsResult {
  os: "windows" | "linux" | "macos" | string;
  outcome: DefaultAppOutcome;
}

export type DefaultAppAssociationStatus =
  | { status: "all_default" }
  | { status: "partial"; txt_default: boolean; md_default: boolean }
  | { status: "none" }
  | { status: "unknown"; reason: string };

export interface DefaultAppStatusResult {
  os: "windows" | "linux" | "macos" | string;
  status: DefaultAppAssociationStatus;
}

export interface DefaultAppInstructions {
  title: string;
  subtitle: string;
  steps: string[];
  note?: string;
}

/**
 * Consulta el estado real de las asociaciones de archivos en el sistema operativo
 * para determinar si Lyra es la aplicación predeterminada para .txt y .md.
 */
export async function checkDefaultAppStatus(): Promise<DefaultAppStatusResult> {
  try {
    return await invoke<DefaultAppStatusResult>("get_default_app_status");
  } catch (err) {
    const os = await getEffectiveOs();
    return {
      os,
      status: {
        status: "unknown",
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Detecta el sistema operativo del cliente actual a través del backend Tauri
 * o mediante el entorno del navegador/Node como fallback seguro.
 */
export async function getEffectiveOs(): Promise<"windows" | "linux" | "macos" | string> {
  try {
    const os = await invoke<string>("get_platform_os");
    if (os) return os.toLowerCase();
  } catch {
    // Entorno de prueba o sin IPC activo
  }
  return detectFallbackOs();
}

export function detectFallbackOs(userAgent?: string, platform?: string): "windows" | "linux" | "macos" {
  const ua = (userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")).toLowerCase();
  const plat = (platform ?? (typeof navigator !== "undefined" ? (navigator as unknown as { platform?: string }).platform : "") ?? "").toLowerCase();

  if (plat.includes("win") || ua.includes("windows")) {
    return "windows";
  }
  if (plat.includes("mac") || ua.includes("macintosh") || ua.includes("mac os")) {
    return "macos";
  }
  return "linux";
}

/**
 * Invoca el backend de Tauri para abrir la configuración del sistema operativo.
 */
export async function configureDefaultApp(): Promise<DefaultAppSettingsResult> {
  try {
    return await invoke<DefaultAppSettingsResult>("open_default_apps_settings");
  } catch (err) {
    const os = await getEffectiveOs();
    return {
      os,
      outcome: {
        type: "instructions_needed",
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Devuelve las instrucciones estructuradas para el sistema operativo especificado.
 */
export function getDefaultAppInstructions(os: string): DefaultAppInstructions {
  const normalized = os.toLowerCase();

  if (normalized === "macos") {
    return {
      title: "Configurar Lyra como predeterminada en macOS",
      subtitle:
        "macOS gestiona las asociaciones de archivos por extensión desde el Finder siguiendo estos pasos:",
      steps: [
        "Selecciona en el Finder cualquier archivo de texto compatible (por ejemplo .txt, .md, .json, .py).",
        "Abre la ventana de información pulsando Cmd + I (o haz clic derecho y selecciona «Obtener información»).",
        "En la sección «Abrir con:», selecciona Lyra en la lista desplegable.",
        "Pulsa el botón «Cambiar todo...» y confirma la acción para aplicar la asociación a todos los archivos de ese tipo.",
      ],
      note: "Puedes repetir este procedimiento con cualquier otra extensión de texto que desees abrir siempre con Lyra.",
    };
  }

  if (normalized === "linux") {
    return {
      title: "Configurar Lyra como predeterminada en Linux",
      subtitle:
        "La forma estándar de asociar extensiones de texto en escritorios Linux es desde tu gestor de archivos:",
      steps: [
        "En tu gestor de archivos (Nautilus, Dolphin, Nemo, Thunar, etc.), haz clic derecho sobre un archivo compatible.",
        "Selecciona «Abrir con...» o «Abrir con otra aplicación...» (o en «Propiedades» > pestaña «Abrir con»).",
        "Elige Lyra en la lista de aplicaciones del sistema.",
        "Marca la casilla «Establecer como predeterminada» o «Recordar esta aplicación para este tipo de archivos».",
      ],
      note: "Si tu entorno de escritorio dispone de un panel de aplicaciones predeterminadas, también puedes consultarlo en la configuración del sistema.",
    };
  }

  // Windows
  return {
    title: "Configurar Lyra como predeterminada en Windows",
    subtitle:
      "Si la ventana de Configuración de Windows no se abrió automáticamente, sigue estos pasos manuales:",
    steps: [
      "Abre la Configuración de Windows presionando la combinación de teclas Win + I.",
      "Dirígete al apartado «Aplicaciones» y selecciona «Aplicaciones predeterminadas».",
      "Busca Lyra en la lista de aplicaciones o escribe la extensión que deseas asociar (por ejemplo .txt o .md).",
      "Selecciona Lyra y establécela como tu aplicación predeterminada.",
    ],
    note: "También puedes hacer clic derecho sobre cualquier archivo en el Explorador de Windows, pulsar «Abrir con» > «Elegir otra aplicación» y marcar «Siempre».",
  };
}
