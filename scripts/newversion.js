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
const cargoLockPath = path.join(rootDir, "src-tauri", "Cargo.lock");

// 0. Verificar que no existan conflictos de merge sin resolver
const conflicts = runCapture("git diff --name-only --diff-filter=U").trim();
if (conflicts) {
  error(`Existen conflictos de merge sin resolver en el repositorio:\n${conflicts}`);
  process.exit(1);
}

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

// 2. Puerta de validación previa: Garantizar código limpio y tests aprobados antes de modificar archivos o Git
log("Ejecutando suite de análisis estático previa al bump (pnpm check)...");
run("pnpm check");

log("Ejecutando pruebas funcionales previas al bump (pnpm test)...");
run("pnpm test");

log("Ejecutando pruebas de backend previas al bump (cargo test)...");
run("cargo test --manifest-path src-tauri/Cargo.toml");

log(`Incrementando a la nueva versión: \x1b[32mv${nextVersion}\x1b[0m`);

// 3. Actualizar package.json
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
success("Actualizado package.json");

// 3. Actualizar tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = nextVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n", "utf8");
success("Actualizado src-tauri/tauri.conf.json");

// 5. Actualizar Cargo.toml
let cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
cargoToml = cargoToml.replace(
  /(\[package\][\s\S]*?version\s*=\s*)"[^"]+"/,
  `$1"${nextVersion}"`
);
fs.writeFileSync(cargoTomlPath, cargoToml, "utf8");
success("Actualizado src-tauri/Cargo.toml");

// 6. Sincronizar src-tauri/Cargo.lock con la versión actualizada
log("Sincronizando src-tauri/Cargo.lock con la nueva versión...");
run("cargo check --manifest-path src-tauri/Cargo.toml");
success("Actualizado y sincronizado src-tauri/Cargo.lock");

// 7. Verificar consistencia estricta de versión en todos los manifiestos
const updatedPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const updatedTauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
const updatedCargoToml = fs.readFileSync(cargoTomlPath, "utf8");
const updatedCargoLock = fs.readFileSync(cargoLockPath, "utf8");

if (updatedPkg.version !== nextVersion) {
  error(`package.json no contiene la versión esperada (${nextVersion})`);
  process.exit(1);
}
if (updatedTauriConf.version !== nextVersion) {
  error(`src-tauri/tauri.conf.json no contiene la versión esperada (${nextVersion})`);
  process.exit(1);
}
if (!updatedCargoToml.includes(`version = "${nextVersion}"`)) {
  error(`src-tauri/Cargo.toml no contiene version = "${nextVersion}"`);
  process.exit(1);
}
if (!updatedCargoLock.includes(`name = "lyra"\nversion = "${nextVersion}"`)) {
  error(`src-tauri/Cargo.lock no contiene la versión ${nextVersion} para el paquete lyra`);
  process.exit(1);
}
success(`Todos los manifiestos de versión verificados correctamente en v${nextVersion}`);

// 5. Cargar clave de firma de Tauri y preparar compilación
const keyPath = path.join(os.homedir(), ".tauri", "lyra.key");
const hasKey = fs.existsSync(keyPath);
const privateKey = hasKey ? fs.readFileSync(keyPath, "utf8").trim() : "";

// Cargar variables OAuth desde el entorno o archivo .env local para compilación de release
let envClientId = process.env.GOOGLE_CLIENT_ID;
let envClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const envPath = path.join(rootDir, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
    if (key === "GOOGLE_CLIENT_ID" && !envClientId) envClientId = val;
    if (key === "GOOGLE_CLIENT_SECRET" && !envClientSecret) envClientSecret = val;
  }
}

if (!envClientId || !envClientSecret) {
  warn("No se detectaron GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en el entorno ni en .env.");
  warn("Los binarios producidos no contendrán credenciales OAuth embebidas en tiempo de compilación.");
}

const buildEnv = {
  TAURI_SIGNING_PRIVATE_KEY: privateKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  NO_STRIP: "1",
  APPIMAGE_EXTRACT_AND_RUN: "1",
  RUST_MIN_STACK: "67108864",
  ...(envClientId ? { GOOGLE_CLIENT_ID: envClientId } : {}),
  ...(envClientSecret ? { GOOGLE_CLIENT_SECRET: envClientSecret } : {}),
};

// 6. Verificación / Compilación
if (skipBuild) {
  log("Omitiendo build local (--no-build). Verificando frontend...");
  run("pnpm run build");
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
        // Solo incluir archivos de la versión actual (excluyendo latest.json para proteger el manifiesto multiplataforma de CI)
        if (basename !== "latest.json" && basename.includes(version)) {
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

  // GitHub Actions es la autoridad oficial para compilar, firmar y generar latest.json multiplataforma.
  // No se genera latest.json localmente para evitar sobrescribir destructivamente el manifiesto oficial de CI.

  if (artifacts.length > 0) {
    log(`Artefactos locales encontrados para v${nextVersion} (${artifacts.length}):`);
    for (const art of artifacts) {
      console.log(`  - ${path.basename(art)}`);
    }
  }
}

// 8. Commit y Tag en Git
log("Preparando staging de Git para el commit de release...");

// 1. Agregar todos los cambios de archivos existentes ya rastreados
run("git add -u");

// 2. Agregar explícitamente configuraciones clave de raíz y directorios del proyecto
const essentialEntries = [
  "package.json",
  "pnpm-lock.yaml",
  "eslint.config.js",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "index.html",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  ".github",
  "src",
  "src-tauri",
  "scripts",
  "tests",
];

for (const entry of essentialEntries) {
  if (fs.existsSync(path.join(rootDir, entry))) {
    run(`git add "${entry}"`);
  }
}

// 3. Capturar cualquier otro archivo nuevo que no esté ignorado por .gitignore
run("git add -A");

// Verificar que existan cambios preparados para commitear
const stagedDiff = runCapture("git diff --cached --name-only").trim();
if (!stagedDiff) {
  error("No hay cambios preparados en Git para commitear. Abortando release para evitar generar commits o tags vacíos.");
  process.exit(1);
}

// Crear commit de release
log(`Creando commit de release para v${nextVersion}...`);
run(`git commit -m "release: v${nextVersion}"`);
success(`Commit de release creado: "release: v${nextVersion}"`);

// Verificar que el commit en HEAD corresponda exactamente a la nueva versión
const lastCommitMsg = runCapture("git log -1 --pretty=%B").trim();
if (!lastCommitMsg.startsWith(`release: v${nextVersion}`)) {
  error(`El commit en HEAD ("${lastCommitMsg}") no corresponde a v${nextVersion}. Abortando tag y push.`);
  process.exit(1);
}

const tag = `v${nextVersion}`;

// Verificar que el tag no exista previamente de forma local o remota
const tagExistsLocal = Boolean(runCapture(`git tag -l "${tag}"`));
if (tagExistsLocal) {
  error(`El tag ${tag} ya existe localmente. Abortando para evitar sobreescritura de tags.`);
  process.exit(1);
}

const tagExistsRemote = Boolean(runCapture(`git ls-remote --tags origin "refs/tags/${tag}"`));
if (tagExistsRemote) {
  error(`El tag ${tag} ya existe en el repositorio remoto. Abortando release.`);
  process.exit(1);
}

// Crear el tag anotado
run(`git tag -a ${tag} -m "Release ${tag}"`);
success(`Tag ${tag} creado exitosamente apuntando a HEAD`);

// 9. Push a GitHub
const currentBranch = runCapture("git rev-parse --abbrev-ref HEAD").trim() || "trunk";
log(`Subiendo commit y tag ${tag} a la rama '${currentBranch}' en el repositorio remoto...`);
try {
  run(`git push origin ${currentBranch} ${tag}`);
  success("Git push completado");
} catch {
  warn(`No se pudo hacer push automático a git. Puedes ejecutar manualmente: git push origin ${currentBranch} ${tag}`);
}

// 10. Publicar o adjuntar artefactos en GitHub Release
// Por diseño seguro, GitHub Actions es la autoridad oficial y única para compilar,
// firmar y publicar releases multiplataforma (Ubuntu + Windows) junto con latest.json.
// Para evitar condiciones de carrera, releases parciales o discrepancias de firmas,
// la publicación local se delega automáticamente a GitHub Actions.
const allowLocalReleaseUpload = args.includes("--upload-local") || args.includes("--manual-release");

if (!allowLocalReleaseUpload) {
  log("Publicación delegada exclusivamente al flujo automatizado de GitHub Actions.");
  log(`El tag ${tag} ha sido enviado. GitHub Actions compilará y publicará de forma atómica`);
  log("todos los instaladores multiplataforma (Windows y Linux) junto con latest.json.");
} else {
  const hasGh = Boolean(runCapture("which gh"));
  if (hasGh) {
    log("Modo manual (--upload-local) activado: gestionando release localmente con 'gh'...");
    try {
      const releaseExists = Boolean(runCapture(`gh release view ${tag}`));
      const safeArtifacts = artifacts.filter(a => path.basename(a) !== "latest.json");
      const artifactArgs = safeArtifacts.map(a => `"${a}"`).join(" ");

      if (releaseExists) {
        if (safeArtifacts.length > 0) {
          log(`La release ${tag} ya existe en GitHub. Subiendo artefactos locales...`);
          run(`gh release upload ${tag} ${artifactArgs}`);
          success(`Artefactos locales subidos a la release ${tag}`);
        }
      } else {
        if (safeArtifacts.length > 0) {
          log(`Creando release ${tag} como borrador en GitHub para evitar publicaciones parciales...`);
          run(`gh release create ${tag} ${artifactArgs} --draft --title "Lyra ${tag}" --notes "Lyra ${tag} - Release manual"`);
          success(`Borrador de release ${tag} creado en GitHub (revísalo antes de publicar)`);
        }
      }
    } catch {
      warn("No se pudo gestionar la release localmente con 'gh'.");
    }
  } else {
    warn("GitHub CLI ('gh') no está disponible; la release continuará en GitHub Actions.");
  }
}

console.log("\n\x1b[32m🎉 ¡Proceso finalizado con éxito para Lyra v" + nextVersion + "!\x1b[0m");
log(`GitHub Actions compila y publica automáticamente para Windows, macOS y Linux en: https://github.com/gixi404/lyra/actions\n`);
