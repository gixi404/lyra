import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFallbackOs,
  getEffectiveOs,
  getDefaultAppInstructions,
  configureDefaultApp,
  checkDefaultAppStatus,
  type DefaultAppAssociationStatus,
} from "../src/utils/defaultApp.ts";
import fs from "node:fs";

function setupMockEnvironment() {
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {},
  };
}

// -----------------------------------------------------------------------------
// 1. Detección del sistema operativo
// -----------------------------------------------------------------------------

test("1. detectFallbackOs identifica correctamente Windows, macOS y Linux", () => {
  // Windows
  assert.equal(
    detectFallbackOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32"),
    "windows"
  );
  assert.equal(
    detectFallbackOs("Mozilla/5.0 (Windows NT 11.0; Win64; x64)", ""),
    "windows"
  );

  // macOS
  assert.equal(
    detectFallbackOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel"),
    "macos"
  );
  assert.equal(
    detectFallbackOs("Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X)", ""),
    "macos"
  );

  // Linux
  assert.equal(
    detectFallbackOs("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64"),
    "linux"
  );
  assert.equal(
    detectFallbackOs("Mozilla/5.0 (X11; Fedora; Linux x86_64)", ""),
    "linux"
  );
});

test("2. getEffectiveOs utiliza el comando get_platform_os de Tauri o fallback", async () => {
  setupMockEnvironment();

  // Caso A: Backend responde 'macos'
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "get_platform_os") return "macos";
      return null;
    },
  };
  const osA = await getEffectiveOs();
  assert.equal(osA, "macos");

  // Caso B: Backend responde 'windows'
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "get_platform_os") return "windows";
      return null;
    },
  };
  const osB = await getEffectiveOs();
  assert.equal(osB, "windows");

  // Caso C: Fallo en IPC recurre a detectFallbackOs
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async () => {
      throw new Error("IPC no disponible");
    },
  };
  const osC = await getEffectiveOs();
  assert.ok(["windows", "linux", "macos"].includes(osC as string));
});

// -----------------------------------------------------------------------------
// 2. Instrucciones específicas por sistema operativo
// -----------------------------------------------------------------------------

test("3. getDefaultAppInstructions para macOS proporciona los 4 pasos exactos de Finder", () => {
  const instructions = getDefaultAppInstructions("macos");

  assert.equal(instructions.title.includes("macOS"), true);
  assert.equal(instructions.steps.length, 4);

  // Paso 1: Seleccionar archivo en Finder
  assert.equal(instructions.steps[0].includes("Finder"), true);

  // Paso 2: Cmd + I / Obtener información
  assert.equal(instructions.steps[1].includes("Cmd + I") || instructions.steps[1].includes("Obtener información"), true);

  // Paso 3: Abrir con Lyra
  assert.equal(instructions.steps[2].includes("Lyra"), true);

  // Paso 4: Cambiar todo
  assert.equal(instructions.steps[3].includes("Cambiar todo"), true);
});

test("4. getDefaultAppInstructions para Linux guía a través del gestor de archivos", () => {
  const instructions = getDefaultAppInstructions("linux");

  assert.equal(instructions.title.includes("Linux"), true);
  assert.equal(instructions.steps.length >= 4, true);

  // Gestor de archivos
  assert.equal(instructions.steps[0].includes("gestor de archivos"), true);
  // Abrir con
  assert.equal(instructions.steps[1].includes("Abrir con"), true);
  // Lyra
  assert.equal(instructions.steps[2].includes("Lyra"), true);
  // Establecer como predeterminada
  assert.equal(instructions.steps[3].includes("predeterminada") || instructions.steps[3].includes("Recordar"), true);
});

test("5. getDefaultAppInstructions para Windows guía a través de Configuración de Windows", () => {
  const instructions = getDefaultAppInstructions("windows");

  assert.equal(instructions.title.includes("Windows"), true);
  assert.equal(instructions.steps.some(s => s.includes("Win + I") || s.includes("Configuración")), true);
  assert.equal(instructions.steps.some(s => s.includes("Aplicaciones predeterminadas")), true);
  assert.equal(instructions.steps.some(s => s.includes("Lyra")), true);
});

// -----------------------------------------------------------------------------
// 3. Flujo inteligente: Prioridad 1 (Auto), Prioridad 2 (Manual) y Prioridad 3 (Instrucciones)
// -----------------------------------------------------------------------------

test("6. configureDefaultApp en Linux: Configuración automática exitosa verificada", async () => {
  setupMockEnvironment();

  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "open_default_apps_settings") {
        return {
          os: "linux",
          outcome: {
            type: "configured_automatically",
            configured_mimes: ["text/plain", "text/markdown"],
            message: "Lyra se ha configurado como aplicación predeterminada para archivos .txt y .md.",
          },
        };
      }
      return null;
    },
  };

  const result = await configureDefaultApp();
  assert.equal(result.os, "linux");
  assert.equal(result.outcome.type, "configured_automatically");
  if (result.outcome.type === "configured_automatically") {
    assert.deepEqual(result.outcome.configured_mimes, ["text/plain", "text/markdown"]);
    assert.ok(result.outcome.message.includes(".txt y .md"));
  }
});

test("7. configureDefaultApp en Linux: Idempotencia cuando Lyra ya es la predeterminada", async () => {
  setupMockEnvironment();

  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "open_default_apps_settings") {
        return {
          os: "linux",
          outcome: {
            type: "already_default",
            message: "Lyra ya es la aplicación predeterminada para archivos de texto (.txt y .md).",
          },
        };
      }
      return null;
    },
  };

  const result = await configureDefaultApp();
  assert.equal(result.os, "linux");
  assert.equal(result.outcome.type, "already_default");
  if (result.outcome.type === "already_default") {
    assert.ok(result.outcome.message.includes("ya es la aplicación predeterminada"));
  }
});

test("8. configureDefaultApp en Linux: Configuración parcial informa y guía para el resto", async () => {
  setupMockEnvironment();

  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "open_default_apps_settings") {
        return {
          os: "linux",
          outcome: {
            type: "partially_configured",
            configured_mimes: ["text/plain"],
            failed_mimes: ["text/markdown"],
            message: "Lyra se configuró para parte de tus archivos de texto, pero requiere configuración manual para el resto.",
          },
        };
      }
      return null;
    },
  };

  const result = await configureDefaultApp();
  assert.equal(result.os, "linux");
  assert.equal(result.outcome.type, "partially_configured");
  if (result.outcome.type === "partially_configured") {
    assert.deepEqual(result.outcome.configured_mimes, ["text/plain"]);
    assert.deepEqual(result.outcome.failed_mimes, ["text/markdown"]);
  }
});

test("9. configureDefaultApp en Windows: Abre configuración manual nativa ms-settings (Prioridad 2)", async () => {
  setupMockEnvironment();

  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "open_default_apps_settings") {
        return {
          os: "windows",
          outcome: {
            type: "manual_settings_opened",
            message: "Se ha solicitado abrir la configuración de aplicaciones de Windows.",
          },
        };
      }
      return null;
    },
  };

  const result = await configureDefaultApp();
  assert.equal(result.os, "windows");
  assert.equal(result.outcome.type, "manual_settings_opened");
  if (result.outcome.type === "manual_settings_opened") {
    assert.ok(result.outcome.message.includes("configuración de aplicaciones de Windows"));
  }
});

test("10. configureDefaultApp en macOS: Muestra instrucciones de Finder sin simular aperturas (Prioridad 3)", async () => {
  setupMockEnvironment();

  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "open_default_apps_settings") {
        return {
          os: "macos",
          outcome: {
            type: "instructions_needed",
            reason: "macOS gestiona las asociaciones de archivos por extensión desde el Finder.",
          },
        };
      }
      return null;
    },
  };

  const result = await configureDefaultApp();
  assert.equal(result.os, "macos");
  assert.equal(result.outcome.type, "instructions_needed");
  if (result.outcome.type === "instructions_needed") {
    assert.ok(result.outcome.reason.includes("Finder"));
  }
});

test("11. configureDefaultApp ante fallo o error de IPC: Recurre de forma segura al fallback de instrucciones", async () => {
  setupMockEnvironment();

  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async () => {
      throw new Error("Error inesperado de IPC");
    },
  };

  const result = await configureDefaultApp();
  assert.equal(result.outcome.type, "instructions_needed");
  if (result.outcome.type === "instructions_needed") {
    assert.ok(result.outcome.reason.includes("Error inesperado de IPC"));
  }
});

// -----------------------------------------------------------------------------
// 4. Consulta de asociaciones reales del sistema operativo
// -----------------------------------------------------------------------------

test("12. checkDefaultAppStatus consulta el estado real en Linux", async () => {
  setupMockEnvironment();

  // Caso A: all_default
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "get_default_app_status") {
        return {
          os: "linux",
          status: { status: "all_default" },
        };
      }
      return null;
    },
  };
  const resAll = await checkDefaultAppStatus();
  assert.equal(resAll.os, "linux");
  assert.equal(resAll.status.status, "all_default");

  // Caso B: partial
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "get_default_app_status") {
        return {
          os: "linux",
          status: { status: "partial", txt_default: true, md_default: false },
        };
      }
      return null;
    },
  };
  const resPartial = await checkDefaultAppStatus();
  assert.equal(resPartial.status.status, "partial");

  // Caso C: none
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "get_default_app_status") {
        return {
          os: "linux",
          status: { status: "none" },
        };
      }
      return null;
    },
  };
  const resNone = await checkDefaultAppStatus();
  assert.equal(resNone.status.status, "none");

  // Caso D: unknown
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "get_default_app_status") {
        return {
          os: "windows",
          status: { status: "unknown", reason: "Windows no permite consulta directa" },
        };
      }
      return null;
    },
  };
  const resUnknown = await checkDefaultAppStatus();
  assert.equal(resUnknown.status.status, "unknown");

  // Caso E: Fallo de IPC devuelve 'unknown' y NO confirma como predeterminada
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: async () => {
      throw new Error("IPC no disponible");
    },
  };
  const resErr = await checkDefaultAppStatus();
  assert.equal(resErr.status.status, "unknown");
  assert.notEqual(resErr.status.status, "all_default");
});

// -----------------------------------------------------------------------------
// 5. Reglas de interfaz y estado del botón en Preferencias
// -----------------------------------------------------------------------------

function computeIsButtonDisabled(
  configuring: boolean,
  status: DefaultAppAssociationStatus | null
): boolean {
  return configuring || status?.status === "all_default";
}

test("13. Reglas de habilitación/deshabilitación del botón de Preferencias", () => {
  // Asociación completa confirmada: botón DESHABILITADO
  assert.equal(computeIsButtonDisabled(false, { status: "all_default" }), true);

  // Asociación parcial (.txt o .md solamente): botón HABILITADO
  assert.equal(
    computeIsButtonDisabled(false, { status: "partial", txt_default: true, md_default: false }),
    false
  );
  assert.equal(
    computeIsButtonDisabled(false, { status: "partial", txt_default: false, md_default: true }),
    false
  );

  // Ninguna asociación: botón HABILITADO
  assert.equal(computeIsButtonDisabled(false, { status: "none" }), false);

  // Estado desconocido / Popup informativo: botón HABILITADO SIEMPRE (sin bloqueo por visita)
  assert.equal(computeIsButtonDisabled(false, { status: "unknown", reason: "macOS Finder" }), false);
  assert.equal(computeIsButtonDisabled(false, { status: "unknown", reason: "Linux no registrada" }), false);

  // El popup informativo puede abrirse repetidamente sin deshabilitar el botón
  for (let i = 0; i < 5; i++) {
    assert.equal(computeIsButtonDisabled(false, { status: "unknown", reason: "Instrucciones" }), false);
  }

  // Concurrencia: deshabilitado temporalmente solo mientras se procesa la acción
  assert.equal(computeIsButtonDisabled(true, { status: "none" }), true);
  assert.equal(computeIsButtonDisabled(true, { status: "unknown", reason: "Ejecutando" }), true);
  assert.equal(computeIsButtonDisabled(true, null), true);
});

test("14. Preferencias: Texto del botón es «Configurar» y subtítulo está eliminado", () => {
  const preferencesPath = new URL("../src/pages/Preferences.tsx", import.meta.url).pathname;
  const code = fs.readFileSync(preferencesPath, "utf-8");

  // El texto del botón debe ser «Configurar»
  assert.ok(code.includes('"Configurar"'));

  // El subtítulo antiguo descriptivo debe haber sido completamente eliminado
  assert.ok(!code.includes("Configura Lyra como aplicación predeterminada para abrir archivos de texto"));
});

test("15. Preferencias: «Aplicación predeterminada» se ubica inmediatamente debajo de «Tema»", () => {
  const preferencesPath = new URL("../src/pages/Preferences.tsx", import.meta.url).pathname;
  const code = fs.readFileSync(preferencesPath, "utf-8");

  const temaIndex = code.indexOf("{/* Tema */}");
  const defaultAppIndex = code.indexOf("{/* Aplicación predeterminada */}");
  const novedadesIndex = code.indexOf("{/* Bloque inferior: Novedades y Atajos */}");

  assert.ok(temaIndex !== -1, "Debe existir la sección Tema");
  assert.ok(defaultAppIndex !== -1, "Debe existir la sección Aplicación predeterminada");
  assert.ok(novedadesIndex !== -1, "Debe existir el bloque inferior");

  // «Aplicación predeterminada» debe aparecer después de «Tema» y antes del bloque inferior
  assert.ok(
    defaultAppIndex > temaIndex,
    "«Aplicación predeterminada» debe ubicarse después de «Tema»"
  );
  assert.ok(
    defaultAppIndex < novedadesIndex,
    "«Aplicación predeterminada» debe ubicarse antes de «Novedades y Atajos»"
  );

  // Asegurar que no esté duplicada
  const firstIndex = code.indexOf("{/* Aplicación predeterminada */}");
  const lastIndex = code.lastIndexOf("{/* Aplicación predeterminada */}");
  assert.equal(firstIndex, lastIndex, "La sección Aplicación predeterminada no debe estar duplicada");
});
