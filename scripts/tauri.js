#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// 1. En Linux (especialmente Fedora), linuxdeploy utiliza un binario strip embebido antiguo
// que falla con código de salida 1 al procesar bibliotecas del sistema que contienen
// secciones ELF 0x13 (.relr.dyn, packed relative relocations por defecto en Fedora).
// NO_STRIP=true desactiva este paso sin afectar el binario final de release.
if (process.platform === "linux") {
  if (!process.env.NO_STRIP) {
    process.env.NO_STRIP = "true";
  }
  if (!process.env.APPIMAGE_EXTRACT_AND_RUN) {
    process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
  }
}

// 2. Cargar clave de firma local si existe y no está definida en el entorno
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = path.join(os.homedir(), ".tauri", "lyra.key");
  if (fs.existsSync(keyPath)) {
    try {
      process.env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, "utf-8").trim();
      if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
        process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
      }
    } catch {
      // Ignorar si no se puede leer
    }
  }
}

// 3. Resolver y ejecutar el CLI oficial de Tauri
const tauriCliPath = require.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [tauriCliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.error("Error executing Tauri CLI:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
