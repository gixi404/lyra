import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { themes } from "../utils/helpers";
import {
  getWorkspaceState,
  invalidateWorkspace,
  hasTauriBridge,
  importStrayNote,
  deferStrayNote,
  resolveMigrationItem,
  resolveRetireConflict,
  retryMigration,
  createWorkspace,
  renameWorkspace,
  selectWorkspace,
  deleteWorkspace,
  applySnapshot,
} from "../utils/workspaceClient";
import {
  isGateOpen,
  type ItemAction,
  type RetireAction,
  type WorkspaceSnapshot,
} from "../utils/workspaceState";
import MigrationScreen from "./MigrationScreen";
import MigrationWarnings from "./MigrationWarnings";
import { invoke } from "@tauri-apps/api/core";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { BASE_DIRECTORY } from "../utils/consts";
import { notesPath } from "../utils/workspacePaths";
import { rescueMigratedDrafts } from "../utils/migratedDrafts";
import WorkspaceSelector from "./WorkspaceSelector";
import { prepareEditorsForRelaunch } from "../utils/editorPersistence";
import { savePersistentPreferencesNow } from "../utils/persistentPreferences";
import { fileStore } from "../store/fileStore";
import { resetListScroll } from "../utils/listScroll";
import { navigateTo } from "../router";
import { PAGES } from "../utils/consts";
import { runPreparedWorkspaceSwitch } from "../utils/workspaceTransition";
import { workspaceHasPendingDrafts } from "../utils/workspaceDeletion";
import { resetSyncForWorkspace } from "../store/syncStore";

interface Props {
  children: React.ReactNode;
  /**
   * Called once, only when the backend has opened the gate and a workspace is
   * active. Everything that reads notes (preferences, archive state, Drive
   * status) must start from here, not before.
   */
  onReady?: (snapshot: WorkspaceSnapshot) => Promise<void> | void;
}

function LoadingScreen(): JSX.Element {
  const { isDay } = themes();
  return (
    <div
      className={`min-h-screen w-full flex flex-col items-center justify-center gap-3 ${
        isDay ? "text-neutral-600" : "text-zinc-400"
      }`}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
      <p className="text-sm">Comprobando tus notas…</p>
    </div>
  );
}

/**
 * Boot gate for the workspace migration.
 *
 * The app is rendered only when the backend reports that the gate is open.
 * Until then the user sees the migration screen, where every conflict has to
 * be resolved explicitly. The gate is never bypassed by local state: a failure
 * keeps the migration screen with a retry button and the notes untouched.
 *
 * Outside the Tauri shell (plain browser, Node tests) there is no backend, so
 * the gate steps aside and the app behaves as before.
 */
function WorkspaceGate({ children, onReady }: Props): JSX.Element {
  const bridge = hasTauriBridge();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(bridge);
  const [managementError, setManagementError] = useState<string | null>(null);
  const readyNotified = useRef(false);
  const managementInFlight = useRef(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback(
    async (next: WorkspaceSnapshot) => {
      if (!mounted.current) return;
      if (isGateOpen(next) && next.draftConflictNames.length > 0) {
        await rescueMigratedDrafts(next.draftConflictNames, window.localStorage, {
          createExclusive: (name, content) => invoke<void>("workspace_rescue_draft", { fileName: name, content, expectedWorkspaceId: next.workspace?.id }),
          read: async name => readTextFile(await notesPath(name), BASE_DIRECTORY),
          exists: async name => exists(await notesPath(name), BASE_DIRECTORY),
        });
      }
      if (!mounted.current) return;
      if (next.workspace && isGateOpen(next) && !readyNotified.current) {
        await onReady?.(next);
        if (!mounted.current) return;
        readyNotified.current = true;
      }
      setSnapshot(next);
      setError(null);
    },
    [onReady]
  );

  const refresh = useCallback((): Promise<void> => {
    if (!bridge) return Promise.resolve();
    if (refreshInFlight.current) return refreshInFlight.current;
    const request = (async () => {
      setBusy(true);
      setError(null);
      try {
        await apply(await getWorkspaceState());
      } catch (cause) {
        if (mounted.current) {
          invalidateWorkspace();
          setSnapshot(null);
          readyNotified.current = false;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
    refreshInFlight.current = request;
    void request.finally(() => { if (refreshInFlight.current === request) refreshInFlight.current = null; });
    return request;
  }, [apply, bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!bridge) return;
    const onBindingChanged = () => { void refresh(); };
    window.addEventListener("lyra:workspace_binding_changed", onBindingChanged);
    return () => window.removeEventListener("lyra:workspace_binding_changed", onBindingChanged);
  }, [bridge, refresh]);

  const run = useCallback(
    async (action: () => Promise<WorkspaceSnapshot>) => {
      if (managementInFlight.current) return;
      managementInFlight.current = true;
      setBusy(true);
      try {
        await apply(await action());
      } catch (cause) {
        if (mounted.current) {
          invalidateWorkspace();
          setSnapshot(null);
          readyNotified.current = false;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        managementInFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [apply]
  );

  const onItemAction = useCallback(
    (name: string, action: ItemAction) => void run(() => resolveMigrationItem(name, action)),
    [run]
  );
  const onImport = useCallback(
    (name: string) => void run(() => importStrayNote(name)),
    [run]
  );
  const onDefer = useCallback(
    (name: string) => void run(() => deferStrayNote(name)),
    [run]
  );
  const onRetireAction = useCallback(
    (name: string, action: RetireAction) => void run(() => resolveRetireConflict(name, action)),
    [run]
  );
  const onRetry = useCallback(() => void run(() => retryMigration()), [run]);

  const manage = async (action: () => Promise<WorkspaceSnapshot>): Promise<boolean> => {
    if (busy || managementInFlight.current) return false;
    managementInFlight.current = true;
    setBusy(true);
    setManagementError(null);
    try {
      const next = await action();
      if (snapshot && next.epoch !== snapshot.epoch) resetSyncForWorkspace();
      setSnapshot(next);
      return true;
    } catch (cause) {
      setManagementError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      managementInFlight.current = false;
      setBusy(false);
    }
  };

  const switchWorkspace = async (id: string): Promise<boolean> => {
    if (busy || managementInFlight.current || !snapshot || snapshot.workspace?.id === id) return false;
    managementInFlight.current = true;
    setBusy(true);
    setManagementError(null);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    let selected = false;
    try {
      const next = await runPreparedWorkspaceSwitch({
        flushVisualCommits: () => fileStore.getState().flushPendingExits(),
        prepareEditors: () => prepareEditorsForRelaunch(),
        persistPreferences: savePersistentPreferencesNow,
        select: () => {
          setSnapshot(null);
          invalidateWorkspace();
          readyNotified.current = false;
          return selectWorkspace(id);
        },
      });
      selected = true;
      resetSyncForWorkspace();
      fileStore.getState().resetForWorkspace();
      resetListScroll();
      navigateTo(PAGES.list);
      await apply(next);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!selected) {
        applySnapshot(snapshot);
        setSnapshot(snapshot);
        readyNotified.current = true;
        setManagementError(message);
      } else {
        invalidateWorkspace();
        setSnapshot(null);
        setError(message);
      }
      return false;
    } finally {
      managementInFlight.current = false;
      setBusy(false);
    }
  };

  if (!bridge) return <>{children}</>;

  if (!snapshot) {
    if (error) {
      return (
        <MigrationScreen
          snapshot={{
            required: true,
            done: false,
            phase: null,
            workspace: null,
            workspaces: [],
            legacyWorkspaceId: null,
            epoch: 0,
            items: [],
            blocks: [],
            strays: [],
            retireConflicts: [],
            draftConflictNames: [],
            restoreDir: null,
            drivePaused: true,
            error: null,
          }}
          busy={busy}
          error={error}
          onRetry={onRetry}
          onItemAction={onItemAction}
          onImport={onImport}
          onDefer={onDefer}
          onRetireAction={onRetireAction}
        />
      );
    }
    return <LoadingScreen />;
  }

  if (!isGateOpen(snapshot)) {
    return (
      <MigrationScreen
        snapshot={snapshot}
        busy={busy}
        error={error}
        onRetry={onRetry}
        onItemAction={onItemAction}
        onImport={onImport}
        onDefer={onDefer}
        onRetireAction={onRetireAction}
      />
    );
  }

  return (
    <>
      {children}
      <WorkspaceSelector
        activeId={snapshot.workspace!.id}
        workspaces={snapshot.workspaces}
        busy={busy}
        error={managementError}
        onCreate={(name, kind) => manage(() => createWorkspace(name, kind))}
        onRename={(id, name) => manage(() => renameWorkspace(id, name))}
        onSelect={switchWorkspace}
        onDelete={id => manage(() => {
          if (workspaceHasPendingDrafts(Object.keys(window.localStorage), id, snapshot.legacyWorkspaceId)) {
            throw new Error("Este espacio conserva borradores pendientes. Ábrelo y guarda o recupera esos cambios antes de eliminarlo");
          }
          return deleteWorkspace(id);
        })}
      />
      <MigrationWarnings
        snapshot={snapshot}
        busy={busy}
        onItemAction={onItemAction}
        onImport={onImport}
        onDefer={onDefer}
        onRetireAction={onRetireAction}
      />
    </>
  );
}

export default WorkspaceGate;
