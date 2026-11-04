#!/usr/bin/env node

/**
 * Validates the integrity of a GitHub release before publishing.
 * Verifies that:
 * 1. All required binary assets exist and have non-zero size.
 * 2. All required Minisign signature assets (.sig) exist and have non-zero size.
 * 3. latest.json exists, is coherent, matches tag version, and contains all platforms:
 *    - linux-x86_64 (AppImage)
 *    - linux-x86_64-appimage (AppImage)
 *    - linux-x86_64-deb (DEB)
 *    - linux-x86_64-rpm (RPM)
 *    - windows-x86_64 (MSI)
 *    - windows-x86_64-msi (MSI)
 *    - windows-x86_64-nsis (NSIS setup.exe)
 * 4. Detects and heals any manifest corruption or dropped platforms caused by
 *    concurrent matrix runners overwriting latest.json.
 * 5. Verifies cryptographic signature consistency between .sig assets and manifest entries.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REQUIRED_PLATFORMS = [
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
  "windows-x86_64",
  "windows-x86_64-msi",
  "windows-x86_64-nsis",
];

export const EXPECTED_PACKAGES = [
  { platform: "AppImage", binaryPattern: /\.AppImage$/, sigPattern: /\.AppImage\.sig$/ },
  { platform: "DEB", binaryPattern: /\.deb$/, sigPattern: /\.deb\.sig$/ },
  { platform: "RPM", binaryPattern: /\.rpm$/, sigPattern: /\.rpm\.sig$/ },
  { platform: "MSI", binaryPattern: /\.msi$/, sigPattern: /\.msi\.sig$/ },
  { platform: "NSIS", binaryPattern: /-setup\.exe$/, sigPattern: /-setup\.exe\.sig$/ },
];

export const PLATFORM_MAPPING = {
  "linux-x86_64": "AppImage",
  "linux-x86_64-appimage": "AppImage",
  "linux-x86_64-deb": "DEB",
  "linux-x86_64-rpm": "RPM",
  "windows-x86_64": "MSI",
  "windows-x86_64-msi": "MSI",
  "windows-x86_64-nsis": "NSIS",
};

/**
 * Validates that all required binary artifacts and corresponding .sig signatures are present in the asset list.
 */
export function validateReleaseAssets(assets) {
  if (!assets || !Array.isArray(assets) || assets.length === 0) {
    throw new Error("La release no contiene ningún archivo o la lista de artefactos está vacía.");
  }

  const findAsset = (pattern) => assets.find((a) => pattern.test(a.name));
  const missingArtifacts = [];
  const platformAssetMap = {};

  for (const pkg of EXPECTED_PACKAGES) {
    const binAsset = findAsset(pkg.binaryPattern);
    const sigAsset = findAsset(pkg.sigPattern);

    if (!binAsset) {
      missingArtifacts.push(`Binario para ${pkg.platform} (patrón: ${pkg.binaryPattern}) ausente.`);
    } else if (binAsset.size <= 0) {
      missingArtifacts.push(`Binario para ${pkg.platform} vacío (${binAsset.name}, 0 bytes).`);
    }

    if (!sigAsset) {
      missingArtifacts.push(`Firma para ${pkg.platform} (patrón: ${pkg.sigPattern}) ausente.`);
    } else if (sigAsset.size <= 0) {
      missingArtifacts.push(`Firma para ${pkg.platform} vacía (${sigAsset.name}, 0 bytes).`);
    }

    if (binAsset && sigAsset) {
      platformAssetMap[pkg.platform] = { binary: binAsset, sig: sigAsset };
    }
  }

  if (missingArtifacts.length > 0) {
    throw new Error(`Artefactos faltantes o corruptos en la release:\n  - ${missingArtifacts.join("\n  - ")}`);
  }

  return platformAssetMap;
}

/**
 * Reconciles the manifest against the uploaded assets and their signatures.
 * Automatically restores missing platform entries if concurrent runners overwrote latest.json.
 */
export function reconcileManifest(existingManifest, expectedVersion, releaseNotes, platformAssetMap, getSigContent) {
  let wasModified = false;
  let manifest = existingManifest;

  if (!manifest) {
    wasModified = true;
    manifest = {
      version: expectedVersion,
      notes: releaseNotes || `Lyra v${expectedVersion}`,
      pub_date: new Date().toISOString(),
      platforms: {},
    };
  } else {
    // Clone to prevent mutating argument directly
    manifest = JSON.parse(JSON.stringify(manifest));
    if (manifest.version !== expectedVersion) {
      manifest.version = expectedVersion;
      wasModified = true;
    }
    if (!manifest.platforms || typeof manifest.platforms !== "object") {
      manifest.platforms = {};
      wasModified = true;
    }
  }

  for (const platformKey of REQUIRED_PLATFORMS) {
    const pkgName = PLATFORM_MAPPING[platformKey];
    const expectedInfo = platformAssetMap[pkgName];
    if (!expectedInfo) continue;

    const currentEntry = manifest.platforms[platformKey];
    if (!currentEntry || !currentEntry.url || !currentEntry.signature) {
      const sigContent = getSigContent(expectedInfo.sig.name);
      manifest.platforms[platformKey] = {
        signature: sigContent,
        url: expectedInfo.binary.url,
      };
      wasModified = true;
    } else {
      const expectedSig = getSigContent(expectedInfo.sig.name);
      if (currentEntry.signature.trim() !== expectedSig.trim()) {
        currentEntry.signature = expectedSig;
        wasModified = true;
      }
    }
  }

  return { manifest, wasModified };
}

/**
 * Strictly audits the contents of latest.json.
 */
export function validateManifest(manifest, expectedVersion, platformAssetMap) {
  if (!manifest) {
    throw new Error("latest.json no existe o es nulo.");
  }

  if (manifest.version !== expectedVersion) {
    throw new Error(`Versión en latest.json ('${manifest.version}') no coincide con la versión esperada ('${expectedVersion}').`);
  }

  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    throw new Error("latest.json no contiene un objeto 'platforms' válido.");
  }

  for (const platformKey of REQUIRED_PLATFORMS) {
    const entry = manifest.platforms[platformKey];
    if (!entry) {
      throw new Error(`Plataforma requerida '${platformKey}' no está presente en latest.json.`);
    }

    if (!entry.url || typeof entry.url !== "string") {
      throw new Error(`URL ausente o inválida en latest.json para '${platformKey}'.`);
    }

    if (!entry.url.startsWith("https://github.com/gixi404/lyra/releases/download/")) {
      throw new Error(`URL no autorizada para '${platformKey}': '${entry.url}'. Debe apuntar a GitHub Releases HTTPS oficial.`);
    }

    if (!entry.signature || typeof entry.signature !== "string" || entry.signature.trim().length === 0) {
      throw new Error(`Firma ausente o vacía en latest.json para '${platformKey}'.`);
    }

    const hasMinisignHeader = entry.signature.includes("untrusted comment:");
    if (!hasMinisignHeader && entry.signature.length < 32) {
      throw new Error(`Firma Minisign con formato anómalo o longitud insuficiente para '${platformKey}'.`);
    }

    // Verify corresponding binary file in URL matches asset
    const pkgName = PLATFORM_MAPPING[platformKey];
    const expectedBinaryName = platformAssetMap[pkgName]?.binary.name;
    if (expectedBinaryName && !entry.url.endsWith(expectedBinaryName)) {
      throw new Error(`URL de '${platformKey}' apunta a '${entry.url}', pero se esperaba '${expectedBinaryName}'.`);
    }
  }

  return true;
}

// ---------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const tagArg = args.find((a) => !a.startsWith("--"));
  const checkOnly = args.includes("--check-only");

  function log(msg) {
    console.log(`\x1b[36m[release-validator]\x1b[0m ${msg}`);
  }
  function success(msg) {
    console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
  }
  function warn(msg) {
    console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
  }
  function fail(msg) {
    console.error(`\x1b[31m✖ ERROR: ${msg}\x1b[0m`);
    process.exit(1);
  }

  function runCapture(cmd) {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
  }

  function run(cmd) {
    execSync(cmd, { stdio: "inherit" });
  }

  if (!tagArg) {
    fail("Falta el argumento del tag de release (ej: v2.0.29)");
  }

  const tag = tagArg.startsWith("v") ? tagArg : `v${tagArg}`;
  const expectedVersion = tag.replace(/^v/, "");

  log(`Iniciando validación de integridad para release: ${tag} (versión esperada: ${expectedVersion})`);

  let releaseData;
  try {
    const jsonStr = runCapture(`gh release view ${tag} --json tagName,isDraft,assets,body`);
    releaseData = JSON.parse(jsonStr);
  } catch (err) {
    fail(`No se pudo consultar la release ${tag} con 'gh release view': ${err.message}`);
  }

  const assets = releaseData.assets || [];
  log(`Se encontraron ${assets.length} artefactos adjuntos a la release ${tag}`);

  let platformAssetMap;
  try {
    platformAssetMap = validateReleaseAssets(assets);
    for (const pkg of EXPECTED_PACKAGES) {
      const info = platformAssetMap[pkg.platform];
      success(`Artefactos presentes para ${pkg.platform}: ${info.binary.name} (${info.binary.size} bytes) + ${info.sig.name}`);
    }
  } catch (err) {
    fail(err.message);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-release-val-"));

  function getSigContent(assetName) {
    const destPath = path.join(tempDir, assetName);
    if (!fs.existsSync(destPath)) {
      runCapture(`gh release download ${tag} --pattern "${assetName}" --dir "${tempDir}" --clobber`);
    }
    return fs.readFileSync(destPath, "utf8").trim();
  }

  let latestJson = null;
  const latestAsset = assets.find((a) => a.name === "latest.json");
  if (latestAsset) {
    try {
      const rawContent = getSigContent("latest.json");
      latestJson = JSON.parse(rawContent);
    } catch (e) {
      warn(`latest.json no es un JSON parseable: ${e.message}`);
    }
  }

  const { manifest: reconciledManifest, wasModified } = reconcileManifest(
    latestJson,
    expectedVersion,
    releaseData.body,
    platformAssetMap,
    getSigContent
  );

  if (wasModified) {
    if (checkOnly) {
      fail("latest.json requería actualización o reconciliación de plataformas, pero se ejecutó en modo --check-only.");
    }
    log("Actualizando y unificando latest.json en la release para garantizar compatibilidad multiplataforma...");
    const manifestPath = path.join(tempDir, "latest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(reconciledManifest, null, 2) + "\n", "utf8");
    run(`gh release upload ${tag} "${manifestPath}" --clobber`);
    success("latest.json unificado y subido con éxito a la release");
  }

  log("Ejecutando auditoría final de consistencia sobre latest.json...");
  try {
    validateManifest(reconciledManifest, expectedVersion, platformAssetMap);
    for (const key of REQUIRED_PLATFORMS) {
      success(`Plataforma '${key}' verificada: URL válida y firma Minisign íntegra.`);
    }
  } catch (err) {
    fail(err.message);
  }

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  success(`¡Integridad de la release ${tag} verificada al 100%! Todas las plataformas, binarios y firmas están presentes y coherentes.`);
}
