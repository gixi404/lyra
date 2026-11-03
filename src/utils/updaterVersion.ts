export type InstallationFormat = "appimage" | "deb" | "rpm" | "windows" | "macos" | "standalone";

export interface InstallationInfo {
  format: InstallationFormat;
  is_package_managed: boolean;
  bundle_type: string | null;
  supports_official_updater: boolean;
}

export interface NativeUpdateInfo {
  version: string;
  url: string;
  signature: string;
  notes?: string;
  pub_date?: string;
  package_format: InstallationFormat;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export type UpdateFailureCategory = "cancelled" | "auth_denied" | "install_failed";

export interface UpdateFailureInfo {
  category: UpdateFailureCategory;
  message: string;
}

export function categorizeUpdateError(error: unknown): UpdateFailureInfo {
  if (!error) {
    return {
      category: "install_failed",
      message: "Error desconocido durante la actualización.",
    };
  }

  const rawMsg = String((error as any)?.message || error || "").trim();
  const lower = rawMsg.toLowerCase();

  // 1. Explicit tokens returned from Rust backend
  if (
    rawMsg.startsWith("UPDATE_CANCELLED:") ||
    lower.includes("request dismissed") ||
    lower.includes("rehusó la autenticación") ||
    lower.includes("descartó") ||
    lower.includes("descartada") ||
    lower.includes("user dismissed") ||
    lower.includes("user cancelled") ||
    lower.includes("user canceled") ||
    lower.includes("actualización cancelada")
  ) {
    return {
      category: "cancelled",
      message: "Actualización cancelada",
    };
  }

  if (
    rawMsg.startsWith("AUTH_DENIED:") ||
    lower.includes("not authorized") ||
    lower.includes("no autorizado") ||
    lower.includes("authorization refused") ||
    lower.includes("autorización denegada") ||
    lower.includes("autorización rechazada") ||
    lower.includes("directiva de seguridad")
  ) {
    return {
      category: "auth_denied",
      message: "Permisos administrativos no otorgados o denegados por la directiva del sistema.",
    };
  }

  if (rawMsg.startsWith("INSTALL_FAILED:")) {
    const details = rawMsg.replace("INSTALL_FAILED:", "").trim();
    return {
      category: "install_failed",
      message: details || "Error en el gestor de paquetes.",
    };
  }

  // 2. Generic fallbacks for third-party or Tauri updater errors
  if (lower.includes("cancelad") || lower.includes("dismissed") || lower.includes("canceled") || lower.includes("cancelled")) {
    return {
      category: "cancelled",
      message: "Actualización cancelada",
    };
  }

  if (
    lower.includes("permission denied") ||
    lower.includes("os error 13") ||
    lower.includes("permisos no otorgados") ||
    lower.includes("permisos administrativos")
  ) {
    return {
      category: "auth_denied",
      message: "Permisos administrativos no otorgados o denegados.",
    };
  }

  return {
    category: "install_failed",
    message: rawMsg || "No se pudo completar la instalación del paquete.",
  };
}

export function isUpdateCancellation(error: unknown): boolean {
  return categorizeUpdateError(error).category === "cancelled";
}
