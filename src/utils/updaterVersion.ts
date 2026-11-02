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
