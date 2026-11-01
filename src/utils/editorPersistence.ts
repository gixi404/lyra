import type { EditorSyncCoordinator } from "./editorSyncCoordinator";

const sessions = new Map<EditorSyncCoordinator, number>();
let membershipRevision = 0;
const failedDetachedFiles = new Set<string>();
let updateInstallInProgress = false;
const installListeners = new Set<() => void>();

export function subscribeUpdateInstall(listener: () => void): () => void {
  installListeners.add(listener);
  return () => { installListeners.delete(listener); };
}

export function getUpdateInstallInProgress(): boolean {
  return updateInstallInProgress;
}

function setUpdateInstallInProgress(value: boolean): void {
  updateInstallInProgress = value;
  for (const listener of installListeners) listener();
}

export function markDetachedSaveFailure(fileName: string): void {
  failedDetachedFiles.add(fileName);
}

export function clearDetachedSaveFailure(fileName: string): void {
  failedDetachedFiles.delete(fileName);
}

export function moveDetachedSaveFailure(oldName: string, newName: string): void {
  if (failedDetachedFiles.delete(oldName)) failedDetachedFiles.add(newName);
}

export function flushEditorDrafts(): void {
  for (const coordinator of sessions.keys()) coordinator.flushDraft();
}

export function registerEditorSession(coordinator: EditorSyncCoordinator): () => void {
  sessions.set(coordinator, (sessions.get(coordinator) ?? 0) + 1);
  membershipRevision++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = sessions.get(coordinator) ?? 0;
    if (count <= 1) sessions.delete(coordinator);
    else sessions.set(coordinator, count - 1);
    membershipRevision++;
  };
}

export async function prepareEditorsForRelaunch(timeoutMs = 10_000): Promise<boolean> {
  if (failedDetachedFiles.size > 0) return false;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 10; attempt++) {
    const revision = membershipRevision;
    const snapshot = [...sessions.keys()].map(coordinator => ({
      coordinator,
      editRevision: coordinator.getEditRevision(),
    }));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persisted = await Promise.race([
      Promise.all(snapshot.map(({ coordinator }) => coordinator.flushAutosave())),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!persisted || persisted.some(saved => !saved)) return false;
    if (failedDetachedFiles.size > 0) return false;
    if (revision !== membershipRevision) continue;
    if (snapshot.some(({ coordinator, editRevision }) =>
      coordinator.getIsDirty() || coordinator.getEditRevision() !== editRevision)) continue;
    return true;
  }
  return false;
}

export async function runPreparedRelaunch(
  prepare: () => Promise<boolean>,
  persistPreferences: () => Promise<void>,
  relaunch: () => Promise<void>,
): Promise<boolean> {
  if (!(await prepare())) return false;
  await persistPreferences();
  if (!(await prepare())) return false;
  await relaunch();
  return true;
}

export async function runPreparedInstall(
  prepare: () => Promise<boolean>,
  persistPreferences: () => Promise<void>,
  install: () => Promise<void>,
): Promise<boolean> {
  if (!(await prepare())) return false;
  await persistPreferences();
  if (!(await prepare())) return false;
  setUpdateInstallInProgress(true);
  try {
    await install();
    return true;
  } finally {
    setUpdateInstallInProgress(false);
  }
}
