import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { BASE_DIRECTORY, MAIN_FOLDER } from "./consts.ts";
import { draftIdFor } from "./draftStore.ts";
import { flushActiveEditors, flushEditorDrafts, moveDetachedSaveFailure } from "./editorPersistence.ts";
import { getCompatibleStorageKeys } from "./helpers.ts";
import { fileStore } from "../store/fileStore.ts";
import { configStore } from "../store/configStore.ts";
import { savePersistentPreferencesNow } from "./persistentPreferences.ts";
import { remapPath, relocateEntry } from "./folderTree.ts";
import { remapOpenedNoteIdentities } from "./noteIdentity.ts";
import { runPathOperation } from "./pathOperationLock.ts";

export interface PathChange { oldPath: string; newPath: string }
interface PendingMove {
  sourcePath: string;
  destinationPath: string;
  isFolder: boolean;
  phase: "prepared" | "physical" | "awaitingFrontend" | "aborted";
  notes: PathChange[];
}

async function reconcileLocalDrafts(changes: PathChange[], aborted: boolean): Promise<void> {
  for (const change of changes) {
    const oldKeys = getCompatibleStorageKeys(change.oldPath, "", "lyra-draft");
    const newKeys = getCompatibleStorageKeys(change.newPath, "", "lyra-draft");
    const oldKey = oldKeys.find(key => window.localStorage.getItem(key) !== null);
    const oldValue = oldKey ? window.localStorage.getItem(oldKey) : null;
    const newKey = newKeys.find(key => window.localStorage.getItem(key) !== null);
    const newValue = newKey ? window.localStorage.getItem(newKey) : null;
    if (oldValue !== null && newValue !== null && oldValue !== newValue) {
      throw new Error(`Conflicting local drafts for ${change.oldPath} and ${change.newPath} were retained`);
    }
    if (aborted) {
      if (newValue !== null && oldValue === null) throw new Error(`Unattributed prepared draft at ${change.newPath} was retained`);
      if (newKey && oldValue === newValue) window.localStorage.removeItem(newKey);
      const oldDisk = await invoke<string | null>("read_draft_file", { draftId: draftIdFor(change.oldPath) });
      const newDisk = await invoke<string | null>("read_draft_file", { draftId: draftIdFor(change.newPath) });
      if (newDisk !== null) {
        if (oldDisk === null) throw new Error(`Unattributed disk draft at ${change.newPath} was retained`);
        const migrated = JSON.stringify({ ...JSON.parse(oldDisk) as Record<string, unknown>, noteName: change.newPath, draftId: draftIdFor(change.newPath) });
        if (JSON.stringify(JSON.parse(migrated)) !== JSON.stringify(JSON.parse(newDisk))) {
          throw new Error(`Conflicting disk drafts at ${change.newPath} were retained`);
        }
        await invoke("delete_draft_file", { draftId: draftIdFor(change.newPath) });
      }
      continue;
    }
    if (oldValue !== null && !newKey) {
      window.localStorage.setItem(newKeys[0], oldValue);
      if (window.localStorage.getItem(newKeys[0]) !== oldValue) throw new Error(`Moved draft could not be verified at ${change.newPath}`);
    }
    if (oldValue !== null) oldKeys.forEach(key => window.localStorage.removeItem(key));
  }
}

export async function recoverPendingLocalMove(): Promise<void> {
  const pending = await invoke<PendingMove | null>("pending_local_move");
  if (!pending) return;
  if (pending.phase !== "aborted" && pending.phase !== "awaitingFrontend") {
    throw new Error("A local move is still in an unresolved physical phase");
  }
  await reconcileLocalDrafts(pending.notes, pending.phase === "aborted");
  if (pending.phase === "awaitingFrontend") {
    migratePreferences(pending.notes, pending.isFolder
      ? { oldPath: pending.sourcePath, newPath: pending.destinationPath } : undefined);
    remapOpenedNoteIdentities(pending.notes);
  }
  await invoke("acknowledge_local_move", { sourcePath: pending.sourcePath, destinationPath: pending.destinationPath });
}

async function prepareDrafts(changes: PathChange[]): Promise<{ commit: () => Promise<string[]>; rollback: () => Promise<void> }> {
  const staged: Array<{ oldName: string; newName: string; oldId: string; newId: string; hadDisk: boolean; createdDisk: boolean; oldKeys: string[]; newKey: string | null; createdKey: boolean }> = [];
  const rollback = async () => {
    for (const item of staged) {
      if (item.createdKey && item.newKey) window.localStorage.removeItem(item.newKey);
      if (item.createdDisk) await invoke("delete_draft_file", { draftId: item.newId }).catch(() => undefined);
    }
  };
  try {
    for (const change of changes) {
      const oldId = draftIdFor(change.oldPath);
      const newId = draftIdFor(change.newPath);
      const oldRaw = await invoke<string | null>("read_draft_file", { draftId: oldId });
      const newRaw = await invoke<string | null>("read_draft_file", { draftId: newId });
      const oldKeys = getCompatibleStorageKeys(change.oldPath, "", "lyra-draft");
      const newKeys = getCompatibleStorageKeys(change.newPath, "", "lyra-draft");
      let payload: Record<string, unknown> | null = null;
      if (oldRaw !== null) {
        try { payload = JSON.parse(oldRaw) as Record<string, unknown>; }
        catch { throw new Error(`The draft for ${change.oldPath} needs recovery before moving`); }
        if (payload.noteName !== change.oldPath || payload.draftId !== oldId) {
          throw new Error(`The draft for ${change.oldPath} has an unexpected identity`);
        }
      }
      const oldKey = oldKeys.find(key => window.localStorage.getItem(key) !== null);
      const newKey = oldKey ? newKeys[0] : null;
      const nextPayload = payload ? JSON.stringify({ ...payload, noteName: change.newPath, draftId: newId }) : null;
      const oldLocal = oldKey ? window.localStorage.getItem(oldKey) : null;
      const existingLocal = newKeys.map(key => window.localStorage.getItem(key)).find(value => value !== null) ?? null;
      if ((newRaw !== null && newRaw !== nextPayload) || (existingLocal !== null && existingLocal !== oldLocal)) {
        throw new Error(`A different draft already exists at ${change.newPath}`);
      }
      const item = { oldName: change.oldPath, newName: change.newPath, oldId, newId, hadDisk: Boolean(payload), createdDisk: false, oldKeys, newKey, createdKey: false };
      staged.push(item);
      if (nextPayload && newRaw === null) {
        await invoke("save_draft_file", { draftId: newId, payloadJson: nextPayload });
        item.createdDisk = true;
      }
      if (newKey && existingLocal === null && oldLocal !== null) {
        window.localStorage.setItem(newKey, oldLocal);
        item.createdKey = true;
      }
    }
  } catch (error) {
    await rollback();
    throw error;
  }
  return {
    rollback,
    commit: async () => {
      const warnings: string[] = [];
      for (const item of staged) {
        if (item.newKey) {
          try { for (const key of item.oldKeys) window.localStorage.removeItem(key); }
          catch { warnings.push(`The previous local draft for ${item.oldName} was retained`); }
        }
        if (item.hadDisk) {
          try { await invoke("delete_draft_file", { draftId: item.oldId }); }
          catch { warnings.push(`The previous draft backup for ${item.oldName} was retained`); }
        }
        moveDetachedSaveFailure(item.oldName, item.newName);
      }
      return warnings;
    },
  };
}

function migratePreferences(changes: PathChange[], folderMove?: { oldPath: string; newPath: string }): void {
  const rename = (path: string) => folderMove ? remapPath(path, folderMove.oldPath, folderMove.newPath)
    : changes.find(change => change.oldPath === path)?.newPath ?? path;
  for (const change of changes) {
    for (const suffix of ["-modified", "-scroll"]) {
      const oldKeys = getCompatibleStorageKeys(change.oldPath, suffix);
      const newKeys = getCompatibleStorageKeys(change.newPath, suffix);
      const value = oldKeys.map(key => window.localStorage.getItem(key)).find(item => item !== null);
      if (value !== undefined && value !== null) window.localStorage.setItem(newKeys[0], value);
      oldKeys.forEach(key => window.localStorage.removeItem(key));
    }
  }
  let paper: string[] = [];
  try { const parsed: unknown = JSON.parse(window.localStorage.getItem("paper") ?? "[]"); if (Array.isArray(parsed)) paper = parsed.filter((item): item is string => typeof item === "string"); }
  catch { /* A corrupt legacy projection is preserved in the archive ledger. */ }
  window.localStorage.setItem("paper", JSON.stringify(paper.map(rename)));
  if (folderMove) {
    for (const key of ["folderExpanded", "folderOrder"]) {
      let value: Record<string, unknown> = {};
      try { value = JSON.parse(window.localStorage.getItem(key) ?? "{}"); }
      catch { /* Invalid visual preferences are reset without affecting notes. */ }
      const next: Record<string, unknown> = {};
      for (const [path, item] of Object.entries(value)) {
        next[rename(path)] = Array.isArray(item) ? item.map((entry: string) => rename(entry)) : item;
      }
      window.localStorage.setItem(key, JSON.stringify(next));
    }
  }
  // Orden manual de archivos: clave propia "fileOrder" con la misma semántica de rutas.
  // En movimientos de carpeta se remapean claves y valores; en movimientos de archivo se
  // reubica la entrada (mismo padre conserva índice; cruce de carpeta va al final, la
  // posición exacta dentro del destino la fija quien orquesta el movimiento).
  let fileOrder: Record<string, string[]> = {};
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem("fileOrder") ?? "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) fileOrder = raw as Record<string, string[]>;
  } catch { /* Corrupt manual order is rebuilt from scratch without affecting notes. */ }
  if (folderMove) {
    const next: Record<string, string[]> = {};
    for (const [parent, entries] of Object.entries(fileOrder)) {
      if (!Array.isArray(entries)) continue;
      next[rename(parent)] = entries.map((entry: string) => rename(entry));
    }
    fileOrder = next;
  } else {
    for (const change of changes) fileOrder = relocateEntry(fileOrder, change);
  }
  window.localStorage.setItem("fileOrder", JSON.stringify(fileOrder));
  configStore.getState().bumpPrefTick();
  void savePersistentPreferencesNow().catch(() => undefined);
}

export async function moveLocalPath(kind: "file" | "folder", sourcePath: string, destinationPath: string): Promise<string[]> {
  return runPathOperation(() => moveLocalPathLocked(kind, sourcePath, destinationPath));
}

async function moveLocalPathLocked(kind: "file" | "folder", sourcePath: string, destinationPath: string): Promise<string[]> {
  if (!(await flushActiveEditors())) throw new Error("An open note could not be saved; move cancelled");
  await flushEditorDrafts();
  const known = fileStore.getState().files;
  const predicted: PathChange[] = kind === "folder"
    ? known.filter(path => path.startsWith(`${sourcePath}/`)).map(oldPath => ({ oldPath, newPath: remapPath(oldPath, sourcePath, destinationPath) }))
    : [{ oldPath: sourcePath, newPath: destinationPath }];
  const drafts = await prepareDrafts(predicted);
  let changes: PathChange[];
  try {
    changes = await invoke<PathChange[]>(kind === "folder" ? "move_folder_local" : "move_note_local", {
      sourcePath, destinationPath, ...(kind === "folder" ? { expectedNotes: predicted.map(change => change.oldPath) } : {}),
    });
  } catch (error) {
    const status = await invoke<"notMoved" | "pending" | "unknown">("local_move_status", {
      sourcePath, destinationPath,
    }).catch(() => "unknown" as const);
    if (status === "notMoved") await drafts.rollback();
    if (status === "notMoved") {
      await invoke("acknowledge_local_move", { sourcePath, destinationPath }).catch(() => undefined);
    }
    throw error;
  }
  const warnings = await drafts.commit();
  remapOpenedNoteIdentities(changes);
  try { migratePreferences(changes, kind === "folder" ? { oldPath: sourcePath, newPath: destinationPath } : undefined); }
  catch { warnings.push("Visual preferences could not be updated after the move"); }
  const selected = fileStore.getState().selectedFile;
  const selectedNew = changes.find(change => change.oldPath === selected.name)?.newPath;
  if (selectedNew) {
    try {
      const content = await readTextFile(await join(MAIN_FOLDER, selectedNew), BASE_DIRECTORY);
      fileStore.getState().setSelectedFile({ ...selected, name: selectedNew, content });
    } catch { fileStore.getState().setSelectedFile({ name: "", content: "" }); warnings.push("The moved note could not be reopened automatically"); }
  }
  if (kind === "folder") fileStore.getState().setFolders(fileStore.getState().folders.map(path => remapPath(path, sourcePath, destinationPath)));
  fileStore.getState().editedFile();
  await invoke("acknowledge_local_move", { sourcePath, destinationPath });
  return warnings;
}
