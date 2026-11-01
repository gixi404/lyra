#!/usr/bin/env node

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function log(msg) {
  console.log(`\x1b[36m[revertversion]\x1b[0m ${msg}`);
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

function run(cmd) {
  log(`Ejecutando: ${cmd}`);
  execSync(cmd, { cwd: rootDir, stdio: "inherit" });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function runOptional(cmd, label) {
  try {
    run(cmd);
    success(label);
    return true;
  } catch {
    warn(`${label} no se pudo completar (puede que no exista o no haya permisos).`);
    return false;
  }
}

// 1. Verificar que el último commit sea un release
const lastMsg = runCapture("git log -1 --pretty=%s");
if (!lastMsg.startsWith("release: v")) {
  error(`El último commit no es un release: "${lastMsg}"`);
  error("Abortando para evitar revertir cambios no relacionados.");
  process.exit(1);
}

const version = lastMsg.replace(/^release: v/, "").trim();
if (!version) {
  error("No se pudo extraer la versión del commit de release.");
  process.exit(1);
}

log(`Último release detectado: v${version}`);

// 2. Revertir el commit de release (crea un nuevo commit, no reescribe historia)
try {
  run("git revert HEAD --no-edit");
  success("Commit de release revertido");
} catch (e) {
  error("No se pudo revertir el commit de release.");
  process.exit(1);
}

// 3. Eliminar el tag local
runOptional(`git tag -d v${version}`, `Tag local v${version} eliminado`);

// 4. Eliminar el tag remoto (si existe)
runOptional(`git push origin :refs/tags/v${version}`, `Tag remoto v${version} eliminado`);

// 5. Eliminar la release de GitHub (si existe y gh está disponible)
const hasGh = Boolean(runCapture("which gh"));
if (hasGh) {
  runOptional(`gh release delete v${version} --yes`, `Release v${version} eliminada de GitHub`);
} else {
  log("GitHub CLI ('gh') no disponible; se omite la eliminación de la release remota.");
}

// 6. Subir el revert
try {
  run("git push origin HEAD");
  success("Revert subido al repositorio remoto");
} catch {
  warn("No se pudo hacer push automático. Ejecuta 'git push origin HEAD' manualmente.");
}

console.log(`\n\x1b[32m↩ Revertido release v${version}. La versión vuelve al estado anterior.\x1b[0m\n`);
console.log("Nota: si los artefactos ya se publicaron en GitHub, elimínalos manualmente si es necesario.");
