#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

process.env.RUST_MIN_STACK = process.env.RUST_MIN_STACK || "67108864";

function log(msg) {
  console.log(`\x1b[36m[newversion]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}
function warn(msg) {
  console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
}
function error(msg) {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
}

function run(cmd, env = {}) {
  log(`Ejecutando: ${cmd}`);
  execSync(cmd, {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

// 1. Obtener versión actual y calcular siguiente
const pkgPath = path.join(rootDir, "package.json");
const tauriConfPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const currentVersion = pkg.version;
log(`Versión actual: v${currentVersion}`);

const args = process.argv.slice(2).map(a => a.trim());
const skipBuild = args.includes("--skip-build") || args.includes("--no-build") || args.includes("--ci-only");
const versionArg = args.find(a => !a.startsWith("--")) || "patch";
let nextVersion = "";

const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

if (semverRegex.test(versionArg)) {
  nextVersion = versionArg;
} else {
  const parts = currentVersion.split(".").map(n => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    error(`Versión actual no válida en semver: ${currentVersion}`);
    process.exit(1);
  }

  if (versionArg === "major") {
    nextVersion = `${parts[0] + 1}.0.0`;
  } else if (versionArg === "minor") {
    nextVersion = `${parts[0]}.${parts[1] + 1}.0`;
  } else if (versionArg === "patch") {
    nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  } else {
    error(`Argumento desconocido: "${versionArg}". Usa patch, minor, major o una versión explícita como 2.0.4`);
    process.exit(1);
  }
}

log(`Incrementando a la nueva versión: \x1b[32mv${nextVersion}\x1b[0m`);

// 2. Actualizar package.json
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
success("Actualizado package.json");

// 3. Actualizar tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = nextVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n", "utf8");
success("Actualizado src-tauri/tauri.conf.json");

// 4. Actualizar Cargo.toml
let cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
cargoToml = cargoToml.replace(
  /(\[package\][\s\S]*?version\s*=\s*)"[^"]+"/,
  `$1"${nextVersion}"`
);
fs.writeFileSync(cargoTomlPath, cargoToml, "utf8");
success("Actualizado src-tauri/Cargo.toml");

// 5. Cargar clave de firma de Tauri y preparar compilación
const keyPath = path.join(os.homedir(), ".tauri", "lyra.key");
const hasKey = fs.existsSync(keyPath);
const privateKey = hasKey ? fs.readFileSync(keyPath, "utf8").trim() : "";

const buildEnv = {
  TAURI_SIGNING_PRIVATE_KEY: privateKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  NO_STRIP: "1",
  APPIMAGE_EXTRACT_AND_RUN: "1",
  RUST_MIN_STACK: "67108864",
};

// 6. Verificación / Compilación
if (skipBuild) {
  log("Omitiendo build local (--no-build). Verificando tipos y sintaxis...");
  run("pnpm run build");
  run("cargo check --manifest-path src-tauri/Cargo.toml");
  success("Verificación local completada");
} else {
  if (!hasKey) {
    warn(`No se encontró la clave de firma en ${keyPath}`);
    warn("El build local no estará firmado, pero GitHub Actions firmará con el secreto del repo.");
  }
  log("Iniciando build local de frontend y bundles de Tauri...");
  run("pnpm run build");
  run("pnpm run tauri build", buildEnv);
  success("Build local completado con éxito");
}

// 7. Recolectar artefactos generados para la versión actual
const bundleDir = path.join(rootDir, "src-tauri", "target", "release", "bundle");
const artifacts = [];

function searchArtifacts(dir, version) {
  if (!fs.existsSync(dir)) return [];
  const validExts = [".deb", ".rpm", ".appimage", ".msi", ".dmg", ".zip", ".tar.gz", ".sig"];
  const collected = [];
  const seenBasenames = new Set();

  function scan(currentDir, depth = 0) {
    if (depth > 2) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Evitar directorios intermedios de empaquetado (como deb/Lyra_2.0.3_amd64 o appimage/Lyra.AppDir)
        if (entry.name.endsWith(".AppDir") || entry.name.startsWith("Lyra_") || entry.name.startsWith("Lyra-")) {
          continue;
        }
        scan(fullPath, depth + 1);
      } else {
        const basename = entry.name;
        // Ignorar artefactos internos de debian
        if (basename.startsWith("control.") || basename.startsWith("data.") || basename === "debian-binary") {
          continue;
        }
        // Solo incluir archivos de la versión actual o latest.json
        if (basename === "latest.json" || basename.includes(version)) {
          const isKnownAsset = validExts.some(ext => basename.toLowerCase().endsWith(ext));
          if (isKnownAsset && !seenBasenames.has(basename)) {
            seenBasenames.add(basename);
            collected.push(fullPath);
          }
        }
      }
    }
  }

  scan(dir, 0);
  return collected;
}

if (!skipBuild) {
  artifacts.push(...searchArtifacts(bundleDir, nextVersion));

  // Generar latest.json inicial para Linux si existe la firma de AppImage
  const appImageSig = artifacts.find(a => a.endsWith(".AppImage.sig"));
  const appImage = artifacts.find(a => a.endsWith(".AppImage"));
  if (appImage && appImageSig) {
    const sigContent = fs.readFileSync(appImageSig, "utf8").trim();
    const appImageBasename = path.basename(appImage);
    const downloadUrl = `https://github.com/gixi404/lyra/releases/download/v${nextVersion}/${appImageBasename}`;
    const latestJson = {
      version: nextVersion,
      notes: `Lyra v${nextVersion}`,
      pub_date: new Date().toISOString(),
      platforms: {
        "linux-x86_64": {
          signature: sigContent,
          url: downloadUrl,
        },
        "linux-x86_64-appimage": {
          signature: sigContent,
          url: downloadUrl,
        },
      },
    };
    const latestJsonPath = path.join(bundleDir, "latest.json");
    fs.writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2), "utf8");
    if (!artifacts.includes(latestJsonPath)) {
      artifacts.push(latestJsonPath);
    }
    success("Generado latest.json inicial para Linux");
  }

  if (artifacts.length > 0) {
    log(`Artefactos locales encontrados para v${nextVersion} (${artifacts.length}):`);
    for (const art of artifacts) {
      console.log(`  - ${path.basename(art)}`);
    }
  }
}

// 8. Commit y Tag en Git
log("Creando commit y tag en Git...");
run("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
run("git add src/ src-tauri/ scripts/");
try {
  run(`git commit -m "release: v${nextVersion}"`);
} catch {
  warn("No hubo cambios adicionales para commitear.");
}

const tag = `v${nextVersion}`;
try {
  run(`git tag -a ${tag} -m "Release ${tag}"`);
} catch {
  warn(`El tag ${tag} ya existía o no se pudo crear.`);
}

// 9. Push a GitHub
log("Subiendo commits y tags al repositorio remoto...");
try {
  run("git push origin HEAD --tags");
  success("Git push completado");
} catch (e) {
  warn("No se pudo hacer push automático a git. Asegúrate de tener conexión.");
}

// 10. Publicar o adjuntar artefactos en GitHub Release
const hasGh = Boolean(runCapture("which gh"));
if (hasGh) {
  log("Gestionando release en GitHub...");
  try {
    const releaseExists = Boolean(runCapture(`gh release view ${tag}`));
    const artifactArgs = artifacts.map(a => `"${a}"`).join(" ");

    if (releaseExists) {
      if (artifacts.length > 0) {
        log(`La release ${tag} ya existe en GitHub. Subiendo artefactos locales...`);
        run(`gh release upload ${tag} ${artifactArgs} --clobber`);
        success(`Artefactos locales subidos a la release ${tag}`);
      }
    } else {
      if (artifacts.length > 0) {
        log(`Creando release ${tag} en GitHub con artefactos locales...`);
        run(`gh release create ${tag} ${artifactArgs} --title "Lyra ${tag}" --notes "Lyra ${tag} - Actualizaciones automáticas habilitadas"`);
        success(`Release ${tag} creada en GitHub`);
      } else {
        log("Release delegada al flujo de GitHub Actions");
      }
    }
  } catch (err) {
    warn("No se pudo actualizar la release localmente con 'gh'. GitHub Actions la gestionará de forma remota.");
  }
} else {
  log("GitHub CLI ('gh') no está disponible; GitHub Actions creará la release automáticamente.");
}

console.log("\n\x1b[32m🎉 ¡Proceso finalizado con éxito para Lyra v" + nextVersion + "!\x1b[0m");
log(`GitHub Actions compila y publica automáticamente para Windows, macOS y Linux en: https://github.com/gixi404/lyra/actions\n`);
