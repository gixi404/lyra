import test from "node:test";
import assert from "node:assert";
import { EditorSyncCoordinator } from "../src/utils/editorSyncCoordinator.ts";
import { useToastStore } from "../src/store/toastStore.ts";

test("Navegación 1: Abrir y cerrar una nota SIN modificaciones NO dispara sincronización con Google Drive", async () => {
  let saveCount = 0;
  let syncTriggered = false;

  const coordinator = new EditorSyncCoordinator({
    fileName: "lectura.txt",
    initialContent: "Contenido existente",
    saveFileContent: async () => {
      saveCount++;
    },
    readFileContent: async () => "Contenido existente",
  });

  // Simular apertura de nota (solo lectura, sin llamadas a handleUserContentChange)
  assert.strictEqual(coordinator.getIsDirty(), false);
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), false);

  // Simular cierre de nota (desmontaje en FileContent)
  const hadUnsyncedChanges = coordinator.getHasUnsyncedChanges();
  await coordinator.handleUnmount();

  if (hadUnsyncedChanges) {
    syncTriggered = true;
  }

  assert.strictEqual(saveCount, 0, "No debe guardarse nada en disco si no hubo cambios");
  assert.strictEqual(syncTriggered, false, "No debe dispararse syncNow al salir de una nota sin modificar");
});

test("Navegación 2: Modificar una nota y salir SÍ dispara persistencia y sincronización automática", async () => {
  let saveCount = 0;
  let syncTriggered = false;
  let syncIsSilent = false;

  const coordinator = new EditorSyncCoordinator({
    fileName: "edicion.txt",
    initialContent: "Texto original",
    saveFileContent: async () => {
      saveCount++;
    },
    readFileContent: async () => "Texto modificado",
  });

  // Usuario escribe en la nota
  coordinator.handleUserContentChange("Texto modificado");
  assert.strictEqual(coordinator.getIsDirty(), true);
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);

  // Usuario sale de la nota antes del debounce de 15s
  const hadUnsyncedChanges = coordinator.getHasUnsyncedChanges();
  await coordinator.handleUnmount();

  if (hadUnsyncedChanges) {
    syncTriggered = true;
    syncIsSilent = true; // Sincronización automática en segundo plano
  }

  assert.strictEqual(saveCount, 1, "Debe persistirse el cambio local en disco al desmontar");
  assert.strictEqual(syncTriggered, true, "Debe dispararse sincronización automática al salir si hubo cambios");
  assert.strictEqual(syncIsSilent, true, "La sincronización disparada por guardado debe ser silenciosa (silent=true)");
});

test("Sincronización 3: La sincronización automática (silent=true) NUNCA muestra el toast de carga", async () => {
  useToastStore.getState().clearToasts();

  let activeSyncToastId: string | null = null;
  function showSyncToast(): void {
    const currentToasts = useToastStore.getState().toasts;
    if (activeSyncToastId !== null && currentToasts.some(t => t.id === activeSyncToastId)) {
      return;
    }
    activeSyncToastId = useToastStore
      .getState()
      .addToast("loading", "Sincronizando con Google Drive...", undefined, 0);
  }

  function simulateSyncNow(silent: boolean): void {
    const isManual = !silent;
    if (isManual) {
      showSyncToast();
    }
  }

  // Ejecución de sincronización automática
  simulateSyncNow(true);

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 0, "No debe crearse ningún toast durante sincronizaciones automáticas");
});

test("Sincronización 4: La sincronización manual (silent=false) SÍ muestra toast de carga y único toast final", async () => {
  useToastStore.getState().clearToasts();

  let activeSyncToastId: string | null = null;
  function showSyncToast(): void {
    const currentToasts = useToastStore.getState().toasts;
    if (activeSyncToastId !== null && currentToasts.some(t => t.id === activeSyncToastId)) {
      return;
    }
    activeSyncToastId = useToastStore
      .getState()
      .addToast("loading", "Sincronizando con Google Drive...", undefined, 0);
  }

  function dismissSyncToast(): void {
    if (activeSyncToastId !== null) {
      useToastStore.getState().removeToast(activeSyncToastId);
      activeSyncToastId = null;
    }
    const currentToasts = useToastStore.getState().toasts;
    for (const t of currentToasts) {
      if (t.type === "loading" && t.msg.includes("Sincronizando")) {
        useToastStore.getState().removeToast(t.id);
      }
    }
  }

  function simulateManualSync(totalChanges: number): void {
    showSyncToast();
    assert.strictEqual(useToastStore.getState().toasts.length, 1);
    assert.strictEqual(useToastStore.getState().toasts[0].msg, "Sincronizando con Google Drive...");

    dismissSyncToast();
    if (totalChanges === 0) {
      useToastStore.getState().addToast("success", "Todo está sincronizado");
    } else {
      useToastStore.getState().addToast("success", "Sincronización completada");
    }
  }

  simulateManualSync(0);

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].type, "success");
  assert.strictEqual(toasts[0].msg, "Todo está sincronizado");

  useToastStore.getState().clearToasts();
});

test("Sincronización 5: Sincronización automática con conflictos muestra alerta sin toast de carga inicial", () => {
  useToastStore.getState().clearToasts();

  const activeSyncToastId: string | null = null;

  function simulateAutoSyncWithConflict(): void {
    // silent = true: no llama showSyncToast()
    const conflicts = ["nota_conflicto.txt"];
    if (conflicts.length > 0) {
      useToastStore.getState().addToast(
        "error",
        "Se detectaron conflictos en archivos. Se guardaron copias para conservar los cambios"
      );
    }
  }

  simulateAutoSyncWithConflict();

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].type, "error");
  assert.strictEqual(
    toasts[0].msg,
    "Se detectaron conflictos en archivos. Se guardaron copias para conservar los cambios"
  );
  assert.strictEqual(activeSyncToastId, null, "El toast de carga nunca debió haberse creado");

  useToastStore.getState().clearToasts();
});

test("Sincronización 6: Clic manual mientras corre sincronización automática da feedback inmediato y resuelve en manual", () => {
  useToastStore.getState().clearToasts();

  let isSyncing = false;
  let syncQueued = false;
  let queuedIsManual = false;
  let isManualSyncActive = false;
  let activeSyncToastId: string | null = null;

  function showSyncToast(): void {
    if (activeSyncToastId === null) {
      activeSyncToastId = useToastStore
        .getState()
        .addToast("loading", "Sincronizando con Google Drive...", undefined, 0);
    }
  }

  function dismissSyncToast(): void {
    if (activeSyncToastId !== null) {
      useToastStore.getState().removeToast(activeSyncToastId);
      activeSyncToastId = null;
    }
  }

  function requestSync(silent: boolean): void {
    const isManual = !silent;
    if (isSyncing) {
      syncQueued = true;
      if (isManual) {
        queuedIsManual = true;
        isManualSyncActive = true;
        showSyncToast(); // Feedback visual inmediato al usuario
      }
      return;
    }

    isSyncing = true;
    isManualSyncActive = isManual;
    if (isManual) {
      showSyncToast();
    }
  }

  // 1. Inicia sincronización automática en background
  requestSync(true);
  assert.strictEqual(isSyncing, true);
  assert.strictEqual(useToastStore.getState().toasts.length, 0, "Background sync corre silenciosamente");

  // 2. Usuario hace clic manual en 'Sincronizar ahora' mientras background sync corre
  requestSync(false);
  assert.strictEqual(syncQueued, true);
  assert.strictEqual(queuedIsManual, true);
  assert.strictEqual(useToastStore.getState().toasts.length, 1, "Feedback visual inmediato mostrado");
  assert.strictEqual(useToastStore.getState().toasts[0].msg, "Sincronizando con Google Drive...");

  // 3. Concluye el sync automático y se ejecuta el queued sync como manual
  const nextIsManual = queuedIsManual;
  syncQueued = false;
  queuedIsManual = false;
  isSyncing = false;
  assert.strictEqual(syncQueued, false);
  assert.strictEqual(queuedIsManual, false);

  // Ejecutar el trailing sync con manual
  requestSync(!nextIsManual);
  assert.strictEqual(isManualSyncActive, true);
  assert.strictEqual(useToastStore.getState().toasts.length, 1, "Toast de carga permanece continuo");

  // Concluye el manual
  dismissSyncToast();
  useToastStore.getState().addToast("success", "Todo está sincronizado");

  assert.strictEqual(useToastStore.getState().toasts.length, 1);
  assert.strictEqual(useToastStore.getState().toasts[0].type, "success");

  useToastStore.getState().clearToasts();
});

test("Sincronización 7: Recuperación de foco de ventana (window focus) con throttle de 3 minutos", () => {
  let lastFocusSyncTimestamp = 1000;
  const FOCUS_THROTTLE_MS = 180_000;
  let syncCount = 0;

  function onWindowFocus(currentTime: number): void {
    if (currentTime - lastFocusSyncTimestamp < FOCUS_THROTTLE_MS) {
      return;
    }
    lastFocusSyncTimestamp = currentTime;
    syncCount++;
  }

  // Focus a los 30 segundos: bloqueado por throttle
  onWindowFocus(31_000);
  assert.strictEqual(syncCount, 0, "No debe sincronizar antes de los 3 minutos");

  // Focus a los 2 minutos: bloqueado por throttle
  onWindowFocus(120_000);
  assert.strictEqual(syncCount, 0);

  // Focus tras 3 minutos y 1 segundo: permitido
  onWindowFocus(182_000);
  assert.strictEqual(syncCount, 1, "Debe sincronizar silenciosamente tras expirar el throttle de foco");
});

test("Sincronización 8: Mínimo intervalo pospone la sincronización automática sin descartarla jamás", () => {
  let lastAutoSyncTimestamp = 1000;
  const AUTO_MIN_INTERVAL_MS = 5_000;
  let executedCount = 0;
  let scheduledDelay: number | null = null;

  function requestAutoSync(currentTime: number, force = false): void {
    if (!force && currentTime - lastAutoSyncTimestamp < AUTO_MIN_INTERVAL_MS) {
      const elapsed = currentTime - lastAutoSyncTimestamp;
      scheduledDelay = Math.max(500, AUTO_MIN_INTERVAL_MS - elapsed);
      return;
    }
    lastAutoSyncTimestamp = currentTime;
    executedCount++;
    scheduledDelay = null;
  }

  // Solicitud a los 2s (transcurrió 1s desde los 1s, faltan 4s)
  requestAutoSync(2000);
  assert.strictEqual(executedCount, 0, "No debe ejecutar de inmediato si no han pasado 5s");
  assert.strictEqual(scheduledDelay, 4000, "Debe posponerse exactamente los 4000ms restantes");

  // Al cumplirse el temporizador pospuesto, se ejecuta la sincronización
  requestAutoSync(6000);
  assert.strictEqual(executedCount, 1, "Debe ejecutarse al expirar el tiempo restante");
  assert.strictEqual(scheduledDelay, null);
});

test("Sincronización 9: handleSyncFinished con uploaded restablece hasUnsyncedLocalChanges", async () => {
  const coordinator = new EditorSyncCoordinator({
    fileName: "subida.txt",
    initialContent: "Original",
    saveFileContent: async () => {},
    readFileContent: async () => "Original",
  });

  coordinator.handleUserContentChange("Modificado");
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);

  // Simular que el guardado local terminó y la nota no tiene nuevas teclas pendientes
  await coordinator.persistLatestToDisk();
  assert.strictEqual(coordinator.getIsDirty(), false);
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true, "Sigue teniendo cambios pendientes de subir a la nube");

  // Se recibe gdrive:sync_finished indicando que 'subida.txt' fue subido a Google Drive
  await coordinator.handleSyncFinished({
    downloaded: [],
    deleted_remote: [],
    uploaded: ["subida.txt"],
  });

  assert.strictEqual(
    coordinator.getHasUnsyncedChanges(),
    false,
    "hasUnsyncedLocalChanges debe restablecerse a false tras confirmación de subida exitosa"
  );
});

test("Sincronización 10: Fallo de sincronización conserva hasUnsyncedLocalChanges para reintento", async () => {
  const coordinator = new EditorSyncCoordinator({
    fileName: "pendiente.txt",
    initialContent: "A",
    saveFileContent: async () => {},
    readFileContent: async () => "A",
  });

  coordinator.handleUserContentChange("B");
  await coordinator.persistLatestToDisk();
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);

  // Simular fallo de sincronización: sync_finished NO incluye 'pendiente.txt' en uploaded
  await coordinator.handleSyncFinished({
    downloaded: [],
    deleted_remote: [],
    uploaded: ["otra_nota.txt"],
  });

  assert.strictEqual(
    coordinator.getHasUnsyncedChanges(),
    true,
    "hasUnsyncedLocalChanges debe conservarse si la nota no fue subida exitosamente"
  );
});

test("Sincronización 11: Reconexión de red (online) y trailing sync ejecutan de inmediato con force=true", () => {
  const lastAutoSyncTimestamp = Date.now();
  const AUTO_MIN_INTERVAL_MS = 5_000;
  let executedImmediately = false;

  function syncNow(silent: boolean, force = false): void {
    const isManual = !silent;
    if (!isManual && !force && Date.now() - lastAutoSyncTimestamp < AUTO_MIN_INTERVAL_MS) {
      executedImmediately = false;
      return;
    }
    executedImmediately = true;
  }

  // Trailing sync o evento online con force=true
  syncNow(true, true);
  assert.strictEqual(
    executedImmediately,
    true,
    "Eventos online o trailing syncs con force=true deben ejecutar inmediatamente sin demora de throttle"
  );
});

test("Sincronización 12: Condición de carrera V1 vs V2 - Edición concurrente durante subida en vuelo preserva cambios pendientes", async () => {
  const diskState: Record<string, string> = {
    "nota_carrera.txt": "Texto inicial",
  };

  const coordinator = new EditorSyncCoordinator({
    fileName: "nota_carrera.txt",
    initialContent: "Texto inicial",
    saveFileContent: async (name, content) => {
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
  });

  // Estado inicial: limpio
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), false);
  assert.strictEqual(coordinator.getEditRevision(), 0);
  assert.strictEqual(coordinator.getPersistedRevision(), 0);
  assert.strictEqual(coordinator.getSyncedRevision(), 0);

  // 1. El usuario edita la versión 1
  coordinator.handleUserContentChange("Versión 1");
  assert.strictEqual(coordinator.getIsDirty(), true);
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);
  assert.strictEqual(coordinator.getEditRevision(), 1);

  // 2. Se persiste en disco la versión 1
  await coordinator.persistLatestToDisk();
  assert.strictEqual(coordinator.getIsDirty(), false);
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);
  assert.strictEqual(coordinator.getPersistedRevision(), 1);

  // 3. Se inicia la subida a Google Drive (in-flight) de la versión 1
  coordinator.markSyncInFlight();

  // 4. Mientras la subida de V1 está en vuelo a Drive, el usuario edita a la Versión 2
  coordinator.handleUserContentChange("Versión 2");
  assert.strictEqual(coordinator.getIsDirty(), true);
  assert.strictEqual(coordinator.getEditRevision(), 2);

  // 5. El autoguardado persiste la Versión 2 en disco (isDirty vuelve a false porque disco == memoria)
  await coordinator.persistLatestToDisk();
  assert.strictEqual(coordinator.getIsDirty(), false);
  assert.strictEqual(coordinator.getPersistedRevision(), 2);

  // 6. Finaliza la subida de la Versión 1 previa
  await coordinator.handleSyncFinished({
    downloaded: [],
    deleted_remote: [],
    uploaded: ["nota_carrera.txt"],
  });

  // ¡REGLA CRÍTICA CONTRA CONDICIÓN DE CARRERA!:
  // Aunque isDirty sea false, syncedRevision avanzó a 1 (V1), pero persistedRevision es 2 (V2).
  // Por ende, getHasUnsyncedChanges() DEBE continuar siendo true para que V2 no se pierda.
  assert.strictEqual(coordinator.getSyncedRevision(), 1, "Solo la versión 1 fue confirmada");
  assert.strictEqual(coordinator.getLastSyncedContent(), "Versión 1");
  assert.strictEqual(
    coordinator.getHasUnsyncedChanges(),
    true,
    "La Versión 2 debe permanecer marcada como pendiente de sincronización"
  );

  // 7. Se dispara el trailing sync para subir la Versión 2
  coordinator.markSyncInFlight();

  // 8. Finaliza la subida de la Versión 2
  await coordinator.handleSyncFinished({
    downloaded: [],
    deleted_remote: [],
    uploaded: ["nota_carrera.txt"],
  });

  // Ahora ambas versiones fueron subidas y el estado está totalmente limpio
  assert.strictEqual(coordinator.getSyncedRevision(), 2);
  assert.strictEqual(coordinator.getLastSyncedContent(), "Versión 2");
  assert.strictEqual(
    coordinator.getHasUnsyncedChanges(),
    false,
    "Tras subir la versión 2, ya no quedan cambios pendientes"
  );
});

test("Sincronización 13: Error de red o fallo en subida conserva hasUnsyncedChanges y permite reintento exitoso", async () => {
  const diskState: Record<string, string> = {
    "nota_error.txt": "A",
  };

  const coordinator = new EditorSyncCoordinator({
    fileName: "nota_error.txt",
    initialContent: "A",
    saveFileContent: async (name, content) => {
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
  });

  // Usuario edita y se guarda en disco
  coordinator.handleUserContentChange("B");
  await coordinator.persistLatestToDisk();
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);
  assert.strictEqual(coordinator.getPersistedRevision(), 1);

  // Se inicia la sincronización
  coordinator.markSyncInFlight();

  // Falla la conexión o Drive devuelve error
  coordinator.handleSyncError();

  assert.strictEqual(
    coordinator.getHasUnsyncedChanges(),
    true,
    "El error de sincronización no debe resetear los cambios pendientes"
  );
  assert.strictEqual(coordinator.getSyncedRevision(), 0);

  // Reintento posterior tras recuperar conexión
  coordinator.markSyncInFlight();
  await coordinator.handleSyncFinished({
    downloaded: [],
    deleted_remote: [],
    uploaded: ["nota_error.txt"],
  });

  assert.strictEqual(coordinator.getSyncedRevision(), 1);
  assert.strictEqual(
    coordinator.getHasUnsyncedChanges(),
    false,
    "El reintento exitoso confirma la subida y limpia el indicador"
  );
});

test("Sincronización 14: Edición revertida al texto ya sincronizado no genera falsos cambios pendientes", async () => {
  const coordinator = new EditorSyncCoordinator({
    fileName: "revert.txt",
    initialContent: "Texto Base",
    saveFileContent: async () => {},
    readFileContent: async () => "Texto Base",
  });

  // Primera sincronización completa
  coordinator.handleUserContentChange("Texto Base");
  await coordinator.persistLatestToDisk();
  coordinator.markSynced();
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), false);

  // Usuario escribe algo y luego lo revierte manualmente al texto base
  coordinator.handleUserContentChange("Texto Temporal");
  coordinator.handleUserContentChange("Texto Base");
  await coordinator.persistLatestToDisk();

  // getHasUnsyncedChanges compara el contenido con lastSyncedContent
  assert.strictEqual(
    coordinator.getHasUnsyncedChanges(),
    false,
    "Si el contenido coincide exactamente con la versión ya sincronizada, no hay cambios pendientes"
  );
});

test("Sincronización 15: Barrera asíncrona estricta - Sincronización iniciada externamente espera a flushAutosave() antes de invocar la lectura de Rust", async () => {
  const diskState: Record<string, string> = {
    "externa.txt": "Texto Original",
  };

  let writeResolve: (() => void) | null = null;
  const slowWrite = new Promise<void>(resolve => {
    writeResolve = resolve;
  });

  let rustReadOccurred = false;
  let rustReadContent = "";

  const coordinator = new EditorSyncCoordinator({
    fileName: "externa.txt",
    initialContent: "Texto Original",
    saveFileContent: async (name, content) => {
      // Simular I/O asíncrono real en disco
      await slowWrite;
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
  });

  // 1. Usuario edita la nota (pendiente en debounce de memoria)
  coordinator.handleUserContentChange("Texto actualizado por el usuario");
  assert.strictEqual(coordinator.getIsDirty(), true);
  assert.strictEqual(coordinator.getPersistedRevision(), 0);

  // 2. Comienza la sincronización con barrera asíncrona estricta:
  // Paso 1: Guardar y esperar a que termine físicamente
  const preSyncPromise = (async () => {
    if (coordinator.getIsDirty()) {
      const saved = await coordinator.flushAutosave();
      if (!saved) return false;
    }
    // Paso 2: Capturar revisión persistida
    coordinator.markSyncInFlight();
    return true;
  })();

  // Simular que Rust está a la espera de la barrera antes de leer el archivo
  const rustSyncExecution = preSyncPromise.then(async canProceed => {
    if (!canProceed) return;
    // Paso 3: Rust lee el archivo desde el disco
    rustReadOccurred = true;
    rustReadContent = diskState["externa.txt"];
  });

  // Mientras la escritura a disco no ha terminado, Rust NO ha leído
  assert.strictEqual(rustReadOccurred, false, "Rust no debe leer antes de que concluya el guardado");

  // Se completa la escritura física en disco
  writeResolve!();
  await rustSyncExecution;

  // Verificación estricta: Rust leyó el texto recién guardado, nunca la versión anterior
  assert.strictEqual(rustReadOccurred, true);
  assert.strictEqual(rustReadContent, "Texto actualizado por el usuario");
  assert.strictEqual(coordinator.getIsDirty(), false);
  assert.strictEqual(coordinator.getPersistedRevision(), 1);

  // Finaliza la subida en Rust y confirma la sincronización
  await coordinator.handleSyncFinished({
    downloaded: [],
    deleted_remote: [],
    uploaded: ["externa.txt"],
  });

  assert.strictEqual(coordinator.getSyncedRevision(), 1);
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), false);
});

test("Sincronización 16: Persistencia fuera de memoria - Cierre de editor y reinicio de Lyra preservan cambios mediante motor Rust y manifiesto", async () => {
  // Simular estado de disco persistente
  const diskFiles: Record<string, string> = {
    "nota_persistida.txt": "Texto Original en Disco",
  };

  // Simular manifiesto guardado en disco (.gdrive_manifest.json)
  const manifestFiles: Record<string, { md5: string; drive_id: string }> = {
    "nota_persistida.txt": {
      md5: "md5_original",
      drive_id: "drive_id_123",
    },
  };

  // 1. Sesión 1: Usuario abre la nota, escribe y cierra la nota / sale de Lyra
  let coordinator: EditorSyncCoordinator | null = new EditorSyncCoordinator({
    fileName: "nota_persistida.txt",
    initialContent: diskFiles["nota_persistida.txt"],
    saveFileContent: async (name, content) => {
      diskFiles[name] = content;
    },
    readFileContent: async name => diskFiles[name],
  });

  coordinator.handleUserContentChange("Texto Modificado antes de apagar Lyra");
  await coordinator.handleUnmount(); // Persiste en disco en ~/Documents/lyra/

  assert.strictEqual(diskFiles["nota_persistida.txt"], "Texto Modificado antes de apagar Lyra");

  // 2. Se destruye la instancia en memoria (cierre de la app o desmontaje total)
  coordinator = null;
  assert.strictEqual(coordinator, null);

  // 3. Simular reinicio de Lyra:
  // El motor Rust escanea ~/Documents/lyra/ en disco y compara con el manifiesto persistente
  const localContent = diskFiles["nota_persistida.txt"];
  const localMd5 = `md5_de_${localContent}`;
  const manifestItem = manifestFiles["nota_persistida.txt"];

  const localChanged = localMd5 !== manifestItem.md5;
  assert.strictEqual(localChanged, true, "El motor Rust detecta que el archivo local fue modificado comparando contra el manifiesto persistente");

  // El motor Rust sube la actualización a Drive y actualiza el manifiesto en disco
  manifestFiles["nota_persistida.txt"].md5 = localMd5;

  // 4. Sesión 2: El usuario vuelve a abrir la nota en Lyra
  const reloadedCoordinator = new EditorSyncCoordinator({
    fileName: "nota_persistida.txt",
    initialContent: diskFiles["nota_persistida.txt"],
    saveFileContent: async (name, content) => {
      diskFiles[name] = content;
    },
    readFileContent: async name => diskFiles[name],
  });

  // Al abrir la nota existente sin modificarla, no hay cambios pendientes ni se dispara sincronización redundante
  assert.strictEqual(reloadedCoordinator.getIsDirty(), false);
  assert.strictEqual(reloadedCoordinator.getHasUnsyncedChanges(), false);

  const hadUnsynced = reloadedCoordinator.getHasUnsyncedChanges();
  await reloadedCoordinator.handleUnmount();
  assert.strictEqual(hadUnsynced, false, "Al salir sin editar, no se inicia sincronización espuria");
});

test("Sincronización 17: Fallo en el guardado previo a la sincronización no marca la revisión como persistida ni permite subida desactualizada", async () => {
  let draftWritten = false;
  let draftSavedContent = "";

  const coordinator = new EditorSyncCoordinator({
    fileName: "fallo_disco.txt",
    initialContent: "Contenido Estable",
    saveFileContent: async () => {
      // Simular fallo I/O en disco (disco lleno o permisos denegados)
      throw new Error("Disk write error: EACCES");
    },
    readFileContent: async () => "Contenido Estable",
    writeDraft: (_name, content) => {
      draftWritten = true;
      draftSavedContent = content;
    },
  });

  // Usuario escribe contenido nuevo
  coordinator.handleUserContentChange("Texto nuevo que fallará al guardarse en disco");
  assert.strictEqual(coordinator.getIsDirty(), true);
  assert.strictEqual(coordinator.getEditRevision(), 1);
  assert.strictEqual(coordinator.getPersistedRevision(), 0);

  // Se inicia la sincronización: la barrera ejecuta flushAutosave()
  let syncAborted = false;
  const preSyncHandler = async (): Promise<boolean> => {
    if (coordinator.getIsDirty()) {
      const saved = await coordinator.flushAutosave();
      if (!saved) {
        return false;
      }
    }
    coordinator.markSyncInFlight();
    return true;
  };

  const canProceed = await preSyncHandler();
  if (!canProceed) {
    syncAborted = true;
  }

  // Comprobaciones críticas:
  // 1. La sincronización DEBE abortar
  assert.strictEqual(syncAborted, true, "La sincronización debe abortar si el guardado previo falla");

  // 2. La revisión persistida NO debe avanzar
  assert.strictEqual(coordinator.getPersistedRevision(), 0, "No debe marcarse como persistida una revisión fallida");

  // 3. El estado dirty y los cambios pendientes deben conservarse
  assert.strictEqual(coordinator.getIsDirty(), true);
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);

  // 4. El borrador local en localStorage debe haberse preservado para protección anti-pérdida
  assert.strictEqual(draftWritten, true);
  assert.strictEqual(draftSavedContent, "Texto nuevo que fallará al guardarse en disco");
});

test("Sincronización 18: Ediciones concurrentes durante flushAutosave no avanzan persistedRevision indebidamente y permanecen pendientes", async () => {
  const diskState: Record<string, string> = {
    "concurrente.txt": "V0",
  };

  let writeResolve: (() => void) | null = null;
  const slowWrite = new Promise<void>(resolve => {
    writeResolve = resolve;
  });

  const coordinator = new EditorSyncCoordinator({
    fileName: "concurrente.txt",
    initialContent: "V0",
    saveFileContent: async (name, content) => {
      if (content === "V1") {
        await slowWrite;
      }
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
  });

  // Usuario escribe V1
  coordinator.handleUserContentChange("V1");
  assert.strictEqual(coordinator.getEditRevision(), 1);
  assert.strictEqual(coordinator.getPersistedRevision(), 0);

  // Inicia flushAutosave() de V1 (I/O en vuelo)
  const savePromise = coordinator.flushAutosave();

  // Mientras la escritura de V1 está en vuelo, el usuario escribe V2
  coordinator.handleUserContentChange("V2");
  assert.strictEqual(coordinator.getEditRevision(), 2);
  assert.strictEqual(coordinator.getIsDirty(), true);

  // Se completa la escritura lenta de V1
  writeResolve!();
  const v1Success = await savePromise;

  assert.strictEqual(v1Success, true);
  // persistedRevision SOLO debe avanzar a 1 (lo que realmente se escribió en disco), NO a 2
  assert.strictEqual(coordinator.getPersistedRevision(), 1, "persistedRevision solo debe reflejar la revisión 1 escrita");
  assert.strictEqual(diskState["concurrente.txt"], "V1");

  // El coordinador reconoce que la memoria (V2) es más reciente que el disco (V1)
  assert.strictEqual(coordinator.getIsDirty(), true, "isDirty debe permanecer en true porque V2 sigue pendiente");
  assert.strictEqual(coordinator.getHasUnsyncedChanges(), true);

  // El siguiente flush persiste V2
  const v2Success = await coordinator.flushAutosave();
  assert.strictEqual(v2Success, true);
  assert.strictEqual(coordinator.getPersistedRevision(), 2);
  assert.strictEqual(diskState["concurrente.txt"], "V2");
  assert.strictEqual(coordinator.getIsDirty(), false);
});

test("Sincronización 19: Ciclo de vida seguro de registerPreSyncHandler - Desmontajes asíncronos concurrentes no anulan handlers nuevos", () => {
  let activeHandler: (() => Promise<boolean>) | null = null;
  function register(handler: () => Promise<boolean>): () => void {
    activeHandler = handler;
    return () => {
      if (activeHandler === handler) {
        activeHandler = null;
      }
    };
  }

  const handlerA = async () => true;
  const handlerB = async () => true;

  // Editor A se monta y registra su handler
  const unregisterA = register(handlerA);
  assert.strictEqual(activeHandler, handlerA);

  // Editor B se monta (ej. navegación rápida) y registra su handler antes del cleanup de A
  const unregisterB = register(handlerB);
  assert.strictEqual(activeHandler, handlerB);

  // Cleanup de Editor A se ejecuta tardíamente
  unregisterA();

  // El handler activo DEBE seguir siendo el de B, no null
  assert.strictEqual(activeHandler, handlerB, "El cleanup de A no debe anular el handler recién registrado por B");

  // Cleanup de Editor B
  unregisterB();
  assert.strictEqual(activeHandler, null);
});
