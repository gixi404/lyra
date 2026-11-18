import test from "node:test";
import assert from "node:assert/strict";

test("Google Drive remote sync remains centrally disabled and inert in frontend", async () => {
  const { GDRIVE_REMOTE_SYNC_ENABLED } = await import("../src/utils/gdriveRemote.ts");
  assert.equal(GDRIVE_REMOTE_SYNC_ENABLED, false, "flag frontend debe estar deshabilitado");

  // Entorno mínimo para importar el store sin Tauri real.
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = g.window;
  const prevDocument = g.document;
  let invokeCalls = 0;
  try {
    g.window = {
      addEventListener() {},
      removeEventListener() {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }),
      navigator: { onLine: true },
      __TAURI_INTERNALS__: {
        invoke: async () => {
          invokeCalls++;
          throw new Error("invoke no debe llamarse con sync remoto deshabilitado");
        },
      },
      dispatchEvent() {},
      setTimeout,
      clearTimeout,
    };
    g.document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", hidden: false };

    const mod = await import("../src/store/syncStore.ts");
    const store = mod.useSyncStore;

    await store.getState().fetchStatus();
    let s = store.getState();
    assert.equal(s.isConnected, false);
    assert.equal(s.isSyncing, false);
    assert.equal(s.pendingAuthorization, null);
    assert.equal(s.userEmail, null);
    assert.equal(s.hasManageableNotes, false);

    // Operaciones remotas deben ser no-op/inertes sin invocar backend.
    await store.getState().syncNow(false, false, "background");
    await store.getState().syncNow(true, true, "authorization");
    await store.getState().login();
    await store.getState().cancelLogin();
    await store.getState().refreshPendingAuthorization();
    const hasManageable = await store.getState().checkManageableNotes();
    await store.getState().authorizePending(["nota-ficticia"]);
    await store.getState().manageLocalNotes(true);
    await store.getState().dismissPending();
    const logoutOk = await store.getState().logout();

    s = store.getState();
    assert.equal(invokeCalls, 0, "no debe haber peticiones/invocaciones remotas");
    assert.equal(hasManageable, false);
    assert.equal(logoutOk, true);
    assert.equal(s.isConnected, false);
    assert.equal(s.isSyncing, false);
    assert.equal(s.pendingAuthorization, null);
    assert.equal(s.managementNotes, null);
    assert.equal(s.managementAccountLabel, null);
  } finally {
    g.window = prevWindow;
    g.document = prevDocument;
  }
});
