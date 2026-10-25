#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

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

const arg = process.argv[2] ? process.argv[2].trim() : "patch";
let nextVersion = "";

const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

if (semverRegex.test(arg)) {
  nextVersion = arg;
} else {
  const parts = currentVersion.split(".").map(n => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    error(`Versión actual no válida en semver: ${currentVersion}`);
    process.exit(1);
  }

  if (arg === "major") {
    nextVersion = `${parts[0] + 1}.0.0`;
  } else if (arg === "minor") {
    nextVersion = `${parts[0]}.${parts[1] + 1}.0`;
  } else if (arg === "patch") {
    nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  } else {
    error(`Argumento desconocido: "${arg}". Usa patch, minor, major o una versión explícita como 2.0.2`);
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

// 5. Cargar clave de firma de Tauri
const keyPath = path.join(os.homedir(), ".tauri", "lyra.key");
if (!fs.existsSync(keyPath)) {
  error(`No se encontró la clave de firma en ${keyPath}`);
  error("Ejecuta 'pnpm tauri signer generate -w ~/.tauri/lyra.key' primero.");
  process.exit(1);
}

const privateKey = fs.readFileSync(keyPath, "utf8").trim();
const buildEnv = {
  TAURI_SIGNING_PRIVATE_KEY: privateKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
};

// 6. Compilar frontend y bundles firmados de Tauri
log("Iniciando build y generación de firmas criptográficas...");
run("pnpm run build");
run("pnpm run tauri build", buildEnv);
success("Build y firma completados con éxito");

// 7. Recolectar artefactos generados para subir
const bundleDir = path.join(rootDir, "src-tauri", "target", "release", "bundle");
const artifacts = [];

function searchArtifacts(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      searchArtifacts(fullPath);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      // Incluir instaladores, paquetes comprimidos, firmas y latest.json
      if (
        entry.name === "latest.json" ||
        entry.name.endsWith(".tar.gz") ||
        entry.name.endsWith(".tar.gz.sig") ||
        entry.name.endsWith(".zip") ||
        entry.name.endsWith(".sig") ||
        ext === ".rpm" ||
        ext === ".deb" ||
        ext === ".appimage" ||
        ext === ".msi" ||
        ext === ".dmg"
      ) {
        artifacts.push(fullPath);
      }
    }
  }
}

searchArtifacts(bundleDir);
log(`Artefactos encontrados para release (${artifacts.length}):`);
for (const art of artifacts) {
  console.log(`  - ${path.basename(art)}`);
}

// 8. Commit y Tag en Git
log("Creando commit y tag en Git...");
run("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
// Añadir cualquier cambio pendiente en src si lo hubiera
run("git add src/ src-tauri/");
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

// 10. Publicar Release en GitHub con GitHub CLI (gh)
const hasGh = Boolean(runCapture("which gh"));
if (hasGh) {
  if (artifacts.length === 0) {
    warn("No se encontraron artefactos en bundle para publicar en GitHub Release.");
  } else {
    log(`Creando Release en GitHub para ${tag} con los artefactos firmados...`);
    try {
      const artifactArgs = artifacts.map(a => `"${a}"`).join(" ");
      run(`gh release create ${tag} ${artifactArgs} --title "Lyra ${tag}" --notes "Lyra ${tag} - Actualizaciones automáticas habilitadas" --clobber`);
      success(`¡Release ${tag} publicada exitosamente en GitHub!`);
      success(`Los usuarios de Lyra se actualizarán automáticamente a la v${nextVersion}.`);
    } catch (err) {
      error("Error al crear release con 'gh'. Puedes subir los artefactos manualmente desde GitHub Releases.");
    }
  }
} else {
  warn("GitHub CLI ('gh') no está disponible. Sube manualmente los archivos de src-tauri/target/release/bundle a tu release de GitHub.");
}

console.log("\n\x1b[32m🎉 ¡Proceso finalizado con éxito para Lyra v" + nextVersion + "!\x1b[0m\n");
