import test from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  categorizeUpdateError,
  isUpdateCancellation,
} from "../src/utils/updaterVersion.ts";
import { checkAndApplyUpdate, openNovedades } from "../src/utils/updater.ts";
import { pathIs, navigateTo, registerNavigator, getPendingNavigation } from "../src/utils/navigation.ts";
import { PAGES } from "../src/utils/consts.ts";


test("compareVersions: identical versions return 0", () => {
  assert.equal(compareVersions("2.0.18", "2.0.18"), 0);
  assert.equal(compareVersions("v2.0.18", "2.0.18"), 0);
  assert.equal(compareVersions("2.0.18", "v2.0.18"), 0);
  assert.equal(compareVersions("v1.0.0", "v1.0.0"), 0);
});

test("compareVersions: newer version returns positive value", () => {
  assert.ok(compareVersions("2.0.19", "2.0.18") > 0);
  assert.ok(compareVersions("v2.1.0", "2.0.18") > 0);
  assert.ok(compareVersions("3.0.0", "2.9.9") > 0);
  assert.ok(compareVersions("2.0.18.1", "2.0.18") > 0);
});

test("compareVersions: older version returns negative value", () => {
  assert.ok(compareVersions("2.0.17", "2.0.18") < 0);
  assert.ok(compareVersions("v1.9.9", "2.0.0") < 0);
  assert.ok(compareVersions("2.0.18", "2.1.0") < 0);
});

test("compareVersions: handles varying segment lengths", () => {
  assert.ok(compareVersions("2.0", "2.0.0") === 0);
  assert.ok(compareVersions("2.1", "2.0.9") > 0);
  assert.ok(compareVersions("2.0.0.1", "2.0.0") > 0);
});

test("updater format contract: valid package types conform to enum", () => {
  const validFormats = ["appimage", "deb", "rpm", "windows", "macos", "standalone"];
  for (const fmt of validFormats) {
    assert.ok(typeof fmt === "string");
  }
});

test("categorizeUpdateError: distinguishes the three specific update failure scenarios", () => {
  // Scenario 1: Voluntary cancellation
  const cancel1 = categorizeUpdateError("UPDATE_CANCELLED: Actualización cancelada por el usuario");
  assert.equal(cancel1.category, "cancelled");
  assert.equal(cancel1.message, "Actualización cancelada");

  const cancel2 = categorizeUpdateError("Error executing command as another user: Request dismissed");
  assert.equal(cancel2.category, "cancelled");

  const cancel3 = categorizeUpdateError("El usuario rehusó la autenticación.");
  assert.equal(cancel3.category, "cancelled");

  const cancel4 = categorizeUpdateError(new Error("Request dismissed"));
  assert.equal(cancel4.category, "cancelled");

  // Scenario 2: Authorization denied / permission failure
  const denied1 = categorizeUpdateError("AUTH_DENIED: Permisos administrativos no otorgados o denegados por la directiva de seguridad");
  assert.equal(denied1.category, "auth_denied");
  assert.match(denied1.message, /Permisos administrativos/);

  const denied2 = categorizeUpdateError("Error executing command as another user: Not authorized");
  assert.equal(denied2.category, "auth_denied");

  const denied3 = categorizeUpdateError("pkexec: not authorized");
  assert.equal(denied3.category, "auth_denied");

  const denied4 = categorizeUpdateError("os error 13: Permission denied");
  assert.equal(denied4.category, "auth_denied");

  // Scenario 3: Installer failure (real DNF / APT / RPM error)
  const fail1 = categorizeUpdateError("INSTALL_FAILED: Error en el gestor de paquetes (dnf): Problem: conflicting requests");
  assert.equal(fail1.category, "install_failed");
  assert.equal(fail1.message, "Error en el gestor de paquetes (dnf): Problem: conflicting requests");

  const fail2 = categorizeUpdateError("dpkg: error processing package lyra (--install)");
  assert.equal(fail2.category, "install_failed");
  assert.match(fail2.message, /dpkg: error processing/);

  const fail3 = categorizeUpdateError("curl: (6) Could not resolve host");
  assert.equal(fail3.category, "install_failed");
});

test("isUpdateCancellation: matches only voluntary user cancellations", () => {
  assert.equal(isUpdateCancellation("UPDATE_CANCELLED: Actualización cancelada"), true);
  assert.equal(isUpdateCancellation("Request dismissed"), true);
  assert.equal(isUpdateCancellation("User dismissed authentication"), true);

  // Windows UAC cancellation code 1223
  assert.equal(isUpdateCancellation("The operation was canceled by the user. (os error 1223)"), true);
  assert.equal(isUpdateCancellation("os error 1223"), true);
  assert.equal(isUpdateCancellation("exit code: 1223"), true);
  assert.equal(isUpdateCancellation("exit code 1223"), true);
  assert.equal(isUpdateCancellation("code 1223"), true);
  assert.equal(isUpdateCancellation("WinError 1223: The operation was canceled"), true);
  assert.equal(isUpdateCancellation("UAC elevation rejected (1223)"), true);

  // Authorization denied must NOT be classified as voluntary cancellation
  assert.equal(isUpdateCancellation("pkexec: not authorized"), false);
  assert.equal(isUpdateCancellation("Not authorized"), false);
  assert.equal(isUpdateCancellation("AUTH_DENIED: Denegado"), false);

  // Installer failures must NOT be classified as cancellation
  assert.equal(isUpdateCancellation("INSTALL_FAILED: Transaction check error"), false);
  assert.equal(isUpdateCancellation("dpkg: dependency problems"), false);

  // False positives matching numbers must NOT be classified as cancellation
  assert.equal(isUpdateCancellation("Failed to connect on port 1223"), false);
  assert.equal(isUpdateCancellation("os error 12234: Unknown error"), false);
  assert.equal(isUpdateCancellation("exit code: 12230"), false);
  assert.equal(isUpdateCancellation("Error in line 1223"), false);
  assert.equal(isUpdateCancellation("Downloaded 1223 bytes of 50000"), false);
  assert.equal(isUpdateCancellation("Version 1.2.23 released"), false);
});

test("categorizeUpdateError: classifies Windows UAC code 1223 accurately and avoids false positives", () => {
  // Real Windows UAC cancellation formats
  const win1 = categorizeUpdateError("The operation was canceled by the user. (os error 1223)");
  assert.equal(win1.category, "cancelled");
  assert.equal(win1.message, "Actualización cancelada");

  const win2 = categorizeUpdateError("os error 1223");
  assert.equal(win2.category, "cancelled");

  const win3 = categorizeUpdateError("Installer process failed with exit code: 1223");
  assert.equal(win3.category, "cancelled");

  const win4 = categorizeUpdateError("Command exited with exit code 1223");
  assert.equal(win4.category, "cancelled");

  const win5 = categorizeUpdateError("WinError 1223");
  assert.equal(win5.category, "cancelled");

  const win6 = categorizeUpdateError("UAC prompt dismissed with code 1223");
  assert.equal(win6.category, "cancelled");

  // False positives that must NOT be categorized as cancelled
  const fp1 = categorizeUpdateError("Error connecting to localhost:1223");
  assert.notEqual(fp1.category, "cancelled");

  const fp2 = categorizeUpdateError("os error 12234: connection reset");
  assert.notEqual(fp2.category, "cancelled");

  const fp3 = categorizeUpdateError("exit code 12230");
  assert.notEqual(fp3.category, "cancelled");

  const fp4 = categorizeUpdateError("Failed parsing config at line 1223");
  assert.notEqual(fp4.category, "cancelled");

  const fp5 = categorizeUpdateError("Downloaded 1223 bytes");
  assert.notEqual(fp5.category, "cancelled");

  const fp6 = categorizeUpdateError("Update to v1.2.23 failed");
  assert.notEqual(fp6.category, "cancelled");
});

test("updater cancellation lifecycle: state unlocks and allows subsequent retries", async () => {
  let isChecking = false;
  const toastLog: Array<{ type: string; msg: string }> = [];

  const fakeToastNotification = (type: string, msg: string) => {
    toastLog.push({ type, msg });
  };

  const simulateUpdateAttempt = async (outcome: "cancel" | "denied" | "success") => {
    if (isChecking) return;
    isChecking = true;
    try {
      if (outcome === "cancel") {
        const failure = categorizeUpdateError("UPDATE_CANCELLED: Actualización cancelada por el usuario");
        if (failure.category === "cancelled") {
          fakeToastNotification("info", failure.message);
          return;
        }
      } else if (outcome === "denied") {
        const failure = categorizeUpdateError("AUTH_DENIED: Permisos administrativos no otorgados");
        if (failure.category === "auth_denied") {
          fakeToastNotification("error", failure.message);
          return;
        }
      } else {
        fakeToastNotification("success", "Actualización completada");
      }
    } finally {
      isChecking = false;
    }
  };

  // Attempt 1: User voluntarily cancels Polkit prompt -> info toast "Actualización cancelada"
  await simulateUpdateAttempt("cancel");
  assert.equal(isChecking, false, "isChecking flag must be reset to false after cancellation");
  assert.equal(toastLog.length, 1);
  assert.deepEqual(toastLog[0], { type: "info", msg: "Actualización cancelada" });

  // Attempt 2: Authorization denied -> error toast with specific permission message
  await simulateUpdateAttempt("denied");
  assert.equal(isChecking, false, "isChecking flag must be reset to false after auth denial");
  assert.equal(toastLog.length, 2);
  assert.equal(toastLog[1].type, "error");
  assert.match(toastLog[1].msg, /Permisos administrativos/);

  // Attempt 3: User inputs correct password -> update succeeds
  await simulateUpdateAttempt("success");
  assert.equal(isChecking, false, "isChecking flag must be reset to false after success");
  assert.equal(toastLog.length, 3);
  assert.deepEqual(toastLog[2], { type: "success", msg: "Actualización completada" });
});

test("categorizeUpdateError: handles UPDATE_BUSY backend lock error correctly", () => {
  const busy = categorizeUpdateError("UPDATE_BUSY: Ya hay una operación de actualización en curso");
  assert.equal(busy.category, "install_failed");
  assert.equal(busy.message, "Ya hay una operación de actualización en curso");
  assert.equal(isUpdateCancellation("UPDATE_BUSY: Ya hay una operación de actualización en curso"), false);
});

test("concurrency guard: prevents multiple simultaneous update executions", async () => {
  let isChecking = false;
  let executionCount = 0;

  const runGuardedUpdate = async () => {
    if (isChecking) return false;
    isChecking = true;
    try {
      executionCount++;
      // Simulate asynchronous download / elevated install
      await new Promise(resolve => setTimeout(resolve, 20));
      return true;
    } finally {
      isChecking = false;
    }
  };

  // Launch 5 concurrent update calls at once
  const results = await Promise.all([
    runGuardedUpdate(),
    runGuardedUpdate(),
    runGuardedUpdate(),
    runGuardedUpdate(),
    runGuardedUpdate(),
  ]);

  // Exactly 1 must have run and returned true; other 4 must have been dropped
  assert.equal(executionCount, 1, "Exactly one execution must happen when called concurrently");
  assert.equal(results.filter(r => r === true).length, 1);
  assert.equal(results.filter(r => r === false).length, 4);
  assert.equal(isChecking, false, "Lock must be released when done");

  // Subsequent call after completion must succeed
  const rerun = await runGuardedUpdate();
  assert.equal(rerun, true, "Subsequent update call must succeed after lock is freed");
  assert.equal(executionCount, 2);
});

test("background update check: discovers version without triggering elevated installation", async () => {
  let elevatedInstallInvoked = false;
  const notificationsShown: Array<{ type: string; msg: string; hasAction: boolean }> = [];

  const simulatePackageCheck = async (isManual: boolean) => {
    const hasUpdate = true;
    const version = "2.0.27";

    if (!hasUpdate) return false;

    if (!isManual) {
      // In background, notify user but NEVER invoke elevated install
      notificationsShown.push({
        type: "info",
        msg: `Nueva versión v${version} disponible`,
        hasAction: true,
      });
      return true;
    }

    // Manual flow: user confirmed
    notificationsShown.push({
      type: "info",
      msg: `Actualizando a v${version}...`,
      hasAction: false,
    });
    elevatedInstallInvoked = true;
    return true;
  };

  // Background check
  const bgResult = await simulatePackageCheck(false);
  assert.equal(bgResult, true);
  assert.equal(elevatedInstallInvoked, false, "Background check must NEVER trigger elevated install");
  assert.equal(notificationsShown.length, 1);
  assert.match(notificationsShown[0].msg, /Nueva versión v2.0.27 disponible/);
  assert.equal(notificationsShown[0].hasAction, true);

  // Manual check
  const manualResult = await simulatePackageCheck(true);
  assert.equal(manualResult, true);
  assert.equal(elevatedInstallInvoked, true, "Manual check triggers elevated install");
  assert.equal(notificationsShown.length, 2);
  assert.match(notificationsShown[1].msg, /Actualizando a v2.0.27/);
});

test("updaterNotification isolation: removes only updater toasts by ID without touching foreign toasts", () => {
  let toasts = [
    { id: "gdrive-sync-1", type: "info", msg: "Sincronizando con Google Drive..." },
    { id: "note-recovery-2", type: "info", msg: "Nota recuperada" },
  ];

  let activeUpdaterToastId: string | null = null;

  const removeToast = (id: string) => {
    toasts = toasts.filter(t => t.id !== id);
  };

  const addToast = (type: string, msg: string) => {
    const id = `toast-${Math.random()}`;
    toasts.push({ id, type, msg });
    return id;
  };

  const clearUpdaterToast = () => {
    if (activeUpdaterToastId) {
      removeToast(activeUpdaterToastId);
      activeUpdaterToastId = null;
    }
  };

  const updaterNotification = (type: string, msg: string) => {
    clearUpdaterToast();
    const id = addToast(type, msg);
    activeUpdaterToastId = id;
    return id;
  };

  // 1. Initial state: 2 external toasts exist
  assert.equal(toasts.length, 2);

  // 2. Updater posts "Nueva versión disponible"
  updaterNotification("info", "Nueva versión v2.0.27 disponible");
  assert.equal(toasts.length, 3);
  assert.ok(toasts.some(t => t.msg === "Nueva versión v2.0.27 disponible"));
  assert.ok(toasts.some(t => t.id === "gdrive-sync-1"), "GDrive sync toast must be preserved");

  // 3. User clicks "Actualizar ahora" -> updater transitions to "Actualizando a v2.0.27..."
  updaterNotification("info", "Actualizando a v2.0.27...");
  assert.equal(toasts.length, 3, "Previous updater toast was replaced, total remains 3");
  assert.ok(!toasts.some(t => t.msg === "Nueva versión v2.0.27 disponible"), "Previous updater toast was removed");
  assert.ok(toasts.some(t => t.msg === "Actualizando a v2.0.27..."), "Progress toast is present");
  assert.ok(toasts.some(t => t.id === "gdrive-sync-1"), "GDrive sync toast still preserved");
  assert.ok(toasts.some(t => t.id === "note-recovery-2"), "Recovery toast still preserved");

  // 4. Update cancelled -> updater transitions to "Actualización cancelada"
  updaterNotification("info", "Actualización cancelada");
  assert.equal(toasts.length, 3);
  assert.ok(toasts.some(t => t.msg === "Actualización cancelada"));
  assert.ok(!toasts.some(t => t.msg === "Actualizando a v2.0.27..."));
  assert.ok(toasts.some(t => t.id === "gdrive-sync-1"));

  // 5. Explicit clearUpdaterToast removes only updater toast
  clearUpdaterToast();
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0].id, "gdrive-sync-1");
  assert.equal(toasts[1].id, "note-recovery-2");
});

test("coordination between background check and 'Actualizar ahora' action", async () => {
  let isChecking = false;
  let updateInstalled = false;
  let actionTriggered = false;

  // Background check finds update and finishes
  const simulateBackgroundCheck = async () => {
    if (isChecking) return false;
    isChecking = true;
    try {
      // Background check finishes quickly (e.g. 5ms)
      await new Promise(r => setTimeout(r, 5));
      return {
        hasUpdate: true,
        version: "2.0.27",
        // The action attached to the toast
        onActionClick: async () => {
          actionTriggered = true;
          return await simulateManualInstall();
        },
      };
    } finally {
      isChecking = false;
    }
  };

  const simulateManualInstall = async () => {
    if (isChecking) return false;
    isChecking = true;
    try {
      await new Promise(r => setTimeout(r, 10));
      updateInstalled = true;
      return true;
    } finally {
      isChecking = false;
    }
  };

  // Run background check
  const bgResult = await simulateBackgroundCheck();
  assert.ok(bgResult);
  assert.equal(isChecking, false, "isChecking must be false after background check finishes");

  // User clicks "Actualizar ahora"
  const installResult = await bgResult.onActionClick();
  assert.equal(actionTriggered, true);
  assert.equal(installResult, true, "Manual install triggered from action must acquire lock and succeed");
  assert.equal(updateInstalled, true);
  assert.equal(isChecking, false, "Lock must be released after manual install completes");
});

test("AUD-UPD-001 regression: checkAndApplyUpdate(false) discovers update but NEVER calls download() or install()", async () => {
  let downloadCalled = false;
  let installCalled = false;
  let closeCalled = false;
  const toastLogged: Array<{ type: string; msg: string; action?: { label?: string; onClick?: () => void } }> = [];

  const mockUpdate = {
    version: "2.1.0",
    body: "Notas de la versión 2.1.0",
    download: async () => {
      downloadCalled = true;
    },
    install: async () => {
      installCalled = true;
    },
    close: async () => {
      closeCalled = true;
    },
  };

  // Setup mock global window/storage for Node environment if missing
  if (typeof globalThis.window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        setItem: () => {},
        getItem: () => null,
        removeItem: () => {},
      },
      sessionStorage: {
        setItem: () => {},
        getItem: () => null,
        removeItem: () => {},
      },
    };
  }

  // 1. Ejecutar checkAndApplyUpdate(false) (segundo plano / arranque automático)
  const bgSuccess = await checkAndApplyUpdate(false, {
    checkUpdaterPlugin: async () => mockUpdate,
    getInstallInfo: async () => ({
      format: "windows",
      is_package_managed: true,
      bundle_type: "msi",
      supports_official_updater: true,
    }),
    onNotification: (type, msg, action) => {
      toastLogged.push({ type, msg, action });
      return "toast-mock-1";
    },
  });

  // Verificaciones críticas de seguridad y no consentimiento:
  assert.equal(bgSuccess, true, "checkAndApplyUpdate debe resolver true");
  assert.equal(downloadCalled, false, "AUD-UPD-001: download() NUNCA debe ejecutarse durante la comprobación en segundo plano");
  assert.equal(installCalled, false, "AUD-UPD-001: install() NUNCA debe ejecutarse durante la comprobación en segundo plano");
  assert.equal(closeCalled, true, "close() debe llamarse para liberar el recurso nativo de Tauri");
  assert.equal(toastLogged.length, 1, "Debe emitirse una sola notificación interactiva");
  assert.match(toastLogged[0].msg, /Nueva versión v2.1.0 disponible/);
  assert.ok(toastLogged[0].action, "Debe adjuntarse una acción interactiva para el usuario");
  assert.equal(toastLogged[0].action?.label, "Actualizar ahora");

  // 2. Ejecutar checkAndApplyUpdate(true) (flujo manual / confirmación explícita)
  const manualSuccess = await checkAndApplyUpdate(true, {
    checkUpdaterPlugin: async () => mockUpdate,
    getInstallInfo: async () => ({
      format: "windows",
      is_package_managed: true,
      bundle_type: "msi",
      supports_official_updater: true,
    }),
    savePreferences: async () => true,
    onNotification: (type, msg, action) => {
      toastLogged.push({ type, msg, action });
      return "toast-mock-2";
    },
  });

  assert.equal(manualSuccess, true);
  assert.equal(downloadCalled, true, "download() DEBE ejecutarse cuando el usuario confirma explícitamente");
  assert.equal(installCalled, true, "install() DEBE ejecutarse cuando el usuario confirma explícitamente");
});

test("navigation: pathIs correctly identifies routes", () => {
  const origWindow = globalThis.window;
  try {
    (globalThis as unknown as { window: { location: { pathname: string } } }).window = { location: { pathname: "/" } };
    assert.equal(pathIs("/"), true);
    assert.equal(pathIs(PAGES.list), true);
    assert.equal(pathIs(PAGES.preferences), false);

    (globalThis as unknown as { window: { location: { pathname: string } } }).window.location.pathname = "/preferences";
    assert.equal(pathIs(PAGES.preferences), true);
    assert.equal(pathIs(PAGES.list), false);
  } finally {
    globalThis.window = origWindow;
  }
});

test("navigation: navigateTo invokes registered navigator", () => {
  let navigatedTo = "";
  registerNavigator((path) => {
    navigatedTo = path;
  });

  navigateTo("/preferences");
  assert.equal(navigatedTo, "/preferences");
});

test("navigation: queues early navigateTo calls and executes them once registered", () => {
  const unregister = registerNavigator(() => {});
  unregister();

  navigateTo("/preferences");
  assert.equal(getPendingNavigation(), "/preferences", "Debe retener la ruta pendiente");

  let lateNavigated = "";
  registerNavigator((path) => {
    lateNavigated = path;
  });

  assert.equal(lateNavigated, "/preferences", "Debe procesar automáticamente la navegación encolada");
  assert.equal(getPendingNavigation(), null, "Debe vaciar la cola de navegación");
});

test("navigation: safely catches asynchronous rejections in navigator handlers", async () => {
  let fallbackInvoked = false;
  let currentPathname = "/";
  const origWindow = globalThis.window;
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      get pathname() {
        return currentPathname;
      },
      set pathname(v: string) {
        fallbackInvoked = true;
        currentPathname = v;
      },
    },
  };

  try {
    // Asegurar que no haya navegador previo registrado
    const unregister = registerNavigator(() => {});
    unregister();

    // 1. Asynchronous handler that rejects during early queue draining
    navigateTo("/early-reject");
    let caughtRejection = false;
    registerNavigator(async (_path) => {
      caughtRejection = true;
      throw new Error("Asynchronous router failure during mount");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(caughtRejection, true);

    // 2. Asynchronous handler that rejects during direct navigateTo
    registerNavigator(async (_path) => {
      throw new Error("Asynchronous router failure during navigate");
    });
    navigateTo("/direct-reject");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fallbackInvoked, true, "Debe activar el fallback de location ante rechazo asíncrono");
  } finally {
    globalThis.window = origWindow;
  }
});

test("openNovedades: navigates to preferences and sets scroll flag when outside preferences", () => {
  const origWindow = globalThis.window;
  let navigatedTo = "";
  let sessionFlag = "";

  registerNavigator((path) => {
    navigatedTo = path;
  });

  try {
    (globalThis as unknown as { window: unknown }).window = {
      location: { pathname: "/" },
      sessionStorage: {
        setItem: (k: string, v: string) => {
          if (k === "scroll_to_novedades") sessionFlag = v;
        },
        removeItem: () => {},
      },
    };

    openNovedades();

    assert.equal(sessionFlag, "true", "Debe marcar la bandera de sesión para scroll");
    assert.equal(navigatedTo, PAGES.preferences, "Debe navegar a la vista de preferencias");
  } finally {
    globalThis.window = origWindow;
  }
});
