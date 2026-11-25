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
import { remapExplorerKeys } from "./explorerKeys.ts";
import { getFileDirectory } from "./noteName.ts";
import { remapMetadataBindings } from "./metadataIdentity.ts";

export interface PathChange { oldPath: string; newPath: string }
interface PendingMove {
  sourcePath: string;
  destinationPath: string;
  isFolder: boolean;
  phase: "prepared" | "physical" | "awaitingFrontend" | "aborted";
  notes: PathChange[];
  destinationFileOrder?: string[];
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

export function recoverPendingLocalMove(): Promise<void> {
  return runPathOperation(async () => {
    const pending = await invoke<PendingMove | null>("pending_local_move");
    if (!pending) return;
    if (pending.phase !== "aborted" && pending.phase !== "awaitingFrontend") {
      throw new Error("A local move is still in an unresolved physical phase");
    }
    await reconcileLocalDrafts(pending.notes, pending.phase === "aborted");
    if (pending.phase === "awaitingFrontend") {
      const folderMove = pending.isFolder ? { oldPath: pending.sourcePath, newPath: pending.destinationPath } : undefined;
      await migratePreferences(pending.notes, folderMove, pending.destinationFileOrder);
      remapOpenedNoteIdentities(pending.notes);
    }
    await invoke("acknowledge_local_move", { sourcePath: pending.sourcePath, destinationPath: pending.destinationPath });
  });
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

export async function migratePreferences(
  changes: PathChange[],
  folderMove?: { oldPath: string; newPath: string },
  destinationFileOrder?: readonly string[],
): Promise<void> {
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

  // Nombres visibles: remapear metadatos de notas ante cambios de ruta física.
  if (changes.length > 0) {
    let noteNames: Record<string, string> = {};
    try {
      const raw: unknown = JSON.parse(window.localStorage.getItem("noteVisibleNames") ?? "{}");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) noteNames = raw as Record<string, string>;
    } catch { /* metadatos corruptos se reinician sin afectar notas */ }
    let changedNames = false;
    const nextNoteNames: Record<string, string> = {};
    const renameDirect = (path: string) => {
      if (folderMove) return remapPath(path, folderMove.oldPath, folderMove.newPath);
      const direct = changes.find(change => change.oldPath === path);
      return direct ? direct.newPath : path;
    };
    for (const [path, value] of Object.entries(noteNames)) {
      if (typeof value !== "string") continue;
      const rp = renameDirect(path);
      if (rp !== path) changedNames = true;
      const base = rp.split("/").pop() ?? rp;
      if (value === base) { changedNames = true; continue; }
      nextNoteNames[rp] = value;
    }
    if (changedNames || Object.keys(nextNoteNames).length !== Object.keys(noteNames).length) {
      window.localStorage.setItem("noteVisibleNames", JSON.stringify(nextNoteNames));
    }
  }
  if (folderMove) {
    // folderExpanded: remap claves y valores con prefijo (descendientes/clave propia)
    let expanded: Record<string, unknown> = {};
    try { expanded = JSON.parse(window.localStorage.getItem("folderExpanded") ?? "{}"); }
    catch { /* Invalid visual preferences are reset without affecting notes. */ }
    const nextExpanded: Record<string, unknown> = {};
    for (const [path, item] of Object.entries(expanded)) {
      nextExpanded[rename(path)] = item;
    }
    window.localStorage.setItem("folderExpanded", JSON.stringify(nextExpanded));

    // folderOrder: remap todos los descendientes y claves, pero reubicar la carpeta movida explícitamente
    // entre directorios (origen -> final del destino). Conserva posición si mismo directorio o ya migrado.
    const orderKeyForParent = (p: string) => (p === "" ? "$top" : p);
    const findListKey = (obj: Record<string, string[]>, wanted: string): string => {
      if (wanted === "$top") {
        if (Object.prototype.hasOwnProperty.call(obj, "$top")) return "$top";
        if (Object.prototype.hasOwnProperty.call(obj, "")) return "";
        return "$top";
      }
      if (Object.prototype.hasOwnProperty.call(obj, wanted)) return wanted;
      return wanted;
    };
    let folderOrder: Record<string, string[]> = {};
    try {
      const raw: unknown = JSON.parse(window.localStorage.getItem("folderOrder") ?? "{}");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) folderOrder = raw as Record<string, string[]>;
    } catch { /* Corrupt manual order is rebuilt from scratch without affecting notes. */ }
    const oldParent = getFileDirectory(folderMove.oldPath);
    const newParent = getFileDirectory(folderMove.newPath);
    const sameDir = oldParent === newParent;
    const srcKeyWanted = orderKeyForParent(oldParent);
    const dstKeyWanted = orderKeyForParent(newParent);
    // 1) Remapear todos los elementos (descendientes incluidos) y todas las claves
    const remapped: Record<string, string[]> = {};
    for (const [pk, entries] of Object.entries(folderOrder)) {
      if (!Array.isArray(entries)) continue;
      const rKey = rename(pk);
      remapped[rKey] = entries.map((entry: string) => rename(entry));
    }
    const srcKey = findListKey(remapped, srcKeyWanted);
    const dstKey = findListKey(remapped, dstKeyWanted);
    const srcKeyOrig = findListKey(folderOrder, srcKeyWanted);
    const inDst = (remapped[dstKey] ?? remapped[dstKeyWanted] ?? []).includes(folderMove.newPath);
    const inSrc = (remapped[srcKey] ?? remapped[srcKeyWanted] ?? []).includes(folderMove.newPath);
    const originalList = folderOrder[srcKeyOrig] ?? folderOrder[srcKeyWanted] ?? [];
    const oldIdx = originalList.indexOf(folderMove.oldPath);
    const currentDstList = remapped[dstKey] ?? remapped[dstKeyWanted] ?? [];
    const currentIdx = currentDstList.indexOf(folderMove.newPath);
    const removeFromAll = () => {
      for (const k of Object.keys(remapped)) {
        remapped[k] = remapped[k].filter(e => e !== folderMove.newPath);
      }
    };
    const ensureDstKey = (): string => {
      if (Object.prototype.hasOwnProperty.call(remapped, dstKey)) return dstKey;
      if (Object.prototype.hasOwnProperty.call(remapped, dstKeyWanted)) return dstKeyWanted;
      // prefer existing alias for top-level if present
      if (dstKeyWanted === "$top") {
        if (Object.prototype.hasOwnProperty.call(remapped, "")) return "";
      }
      remapped[dstKeyWanted] = remapped[dstKeyWanted] ?? [];
      return dstKeyWanted;
    };
    if (sameDir) {
      removeFromAll();
      const dk = ensureDstKey();
      const list = remapped[dk] ?? [];
      if (oldIdx !== -1) {
        list.splice(Math.min(oldIdx, list.length), 0, folderMove.newPath);
      } else if (currentIdx !== -1) {
        list.splice(Math.min(currentIdx, list.length), 0, folderMove.newPath);
      } else if (inDst || inSrc) {
        if (!list.includes(folderMove.newPath)) list.push(folderMove.newPath);
      }
      remapped[dk] = list;
    } else {
      if (inDst && !inSrc) {
        // ya migrado correctamente: conservar posición actual en destino
      } else {
        removeFromAll();
        const dk = ensureDstKey();
        const list = remapped[dk] ?? [];
        if (!list.includes(folderMove.newPath)) list.push(folderMove.newPath);
        remapped[dk] = list;
      }
    }
    window.localStorage.setItem("folderOrder", JSON.stringify(remapped));

    // Apariencia y nombres visibles: remapear claves con el prefijo de la carpeta movida.
    const appearanceKeys = ["folderColors", "folderTextColors", "folderIconColors", "folderIcons"] as const;
    const visibleNameKeys = ["noteVisibleNames", "folderVisibleNames"] as const;
    for (const appKey of [...appearanceKeys, ...visibleNameKeys]) {
      let appMap: Record<string, string> = {};
      try {
        const raw: unknown = JSON.parse(window.localStorage.getItem(appKey) ?? "{}");
        if (raw && typeof raw === "object" && !Array.isArray(raw)) appMap = raw as Record<string, string>;
      } catch { /* metadatos corruptos se reinician sin afectar notas */ }
      let changed = false;
      const nextApp: Record<string, string> = {};
      const isVisibleNameKey = (visibleNameKeys as readonly string[]).includes(appKey);
      for (const [path, value] of Object.entries(appMap)) {
        if (typeof value !== "string") continue;
        const rp = rename(path);
        if (rp !== path) changed = true;
        // si el segmento físico coincide con el visible tras el movimiento, soltar override (solo nombres visibles)
        if (isVisibleNameKey) {
          const base = rp.split("/").pop() ?? rp;
          if (value === base) { changed = true; continue; }
        }
        nextApp[rp] = value;
      }
      if (changed || Object.keys(nextApp).length !== Object.keys(appMap).length) {
        window.localStorage.setItem(appKey, JSON.stringify(nextApp));
      }
    }
  }
  // Remap paths first, then apply any destination order recorded for this drop.
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
    if (destinationFileOrder && changes.length === 1) {
      fileOrder[getFileDirectory(changes[0].newPath)] = [...destinationFileOrder];
    }
  }
  window.localStorage.setItem("fileOrder", JSON.stringify(fileOrder));
  remapMetadataBindings(changes, folderMove);
  configStore.getState().bumpPrefTick();
  await savePersistentPreferencesNow();
}

export async function moveLocalPath(
  kind: "file" | "folder",
  sourcePath: string,
  destinationPath: string,
  destinationFileOrder?: readonly string[],
): Promise<string[]> {
  return runPathOperation(() => moveLocalPathLocked(kind, sourcePath, destinationPath, false, destinationFileOrder));
}

export async function recoverArchivedPathTo(kind: "file" | "folder", sourcePath: string, destinationPath: string): Promise<string[]> {
  return runPathOperation(() => moveLocalPathLocked(kind, sourcePath, destinationPath, true));
}

async function moveLocalPathLocked(
  kind: "file" | "folder",
  sourcePath: string,
  destinationPath: string,
  recovery: boolean,
  destinationFileOrder?: readonly string[],
): Promise<string[]> {
  if (!(await flushActiveEditors())) throw new Error("An open note could not be saved; move cancelled");
  await flushEditorDrafts();
  const known = fileStore.getState().files;
  const predicted: PathChange[] = kind === "folder"
    ? known.filter(path => path.startsWith(`${sourcePath}/`)).map(oldPath => ({ oldPath, newPath: remapPath(oldPath, sourcePath, destinationPath) }))
    : [{ oldPath: sourcePath, newPath: destinationPath }];
  const drafts = await prepareDrafts(predicted);
  let changes: PathChange[];
  try {
    const command = recovery
      ? (kind === "folder" ? "recover_archived_folder_to" : "recover_archived_note_to")
      : (kind === "folder" ? "move_folder_local" : "move_note_local");
    changes = await invoke<PathChange[]>(command, {
      sourcePath, destinationPath, ...(kind === "folder" && !recovery ? { expectedNotes: predicted.map(change => change.oldPath) } : {}),
      ...(destinationFileOrder && command === "move_note_local" ? { destinationFileOrder } : {}),
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
  // Claves estables del explorador: deben remapearse junto al movimiento físico confirmado
  // para evitar remontajes/parpadeos por cambios de ruta (especialmente en renombrado de carpetas).
  remapExplorerKeys(changes, kind === "folder" ? { oldPath: sourcePath, newPath: destinationPath } : undefined);
  try {
    await migratePreferences(changes, kind === "folder" ? { oldPath: sourcePath, newPath: destinationPath } : undefined, destinationFileOrder);
  } catch {
    throw new Error("Visual preferences could not be updated after the move; the move journal was kept for recovery");
  }
  const selected = fileStore.getState().selectedFile;
  const selectedNew = changes.find(change => change.oldPath === selected.name)?.newPath;
  if (selectedNew) {
    try {
      const content = await readTextFile(await join(MAIN_FOLDER, selectedNew), BASE_DIRECTORY);
      fileStore.getState().setSelectedFile({ ...selected, name: selectedNew, content });
    } catch { fileStore.getState().setSelectedFile({ name: "", content: "" }); warnings.push("The moved note could not be reopened automatically"); }
  }
  // Actualización localizada de referencias de rutas reales confirmadas en store
  // (demostrada necesaria para reflejo inmediato; no remapea estados transitorios/derivados).
  // La generación se incrementa junto al estado publicado para invalidar lecturas obsoletas.
  if (kind === "folder") {
    const remap = (path: string) => remapPath(path, sourcePath, destinationPath);
    fileStore.setState(state => {
      const nextStats: Record<string, (typeof state.statsMap)[string]> = {};
      for (const [path, stat] of Object.entries(state.statsMap)) nextStats[remap(path)] = stat;
      return {
        files: state.files.map(remap),
        folders: state.folders.map(remap),
        statsMap: nextStats,
        archivedFolders: state.archivedFolders.map(remap),
        listingGeneration: state.listingGeneration + 1,
        fileIsEdited: !state.fileIsEdited,
      };
    });
  } else {
    const change = changes[0];
    if (change) {
      fileStore.setState(state => {
        const nextStats = { ...state.statsMap };
        if (Object.prototype.hasOwnProperty.call(nextStats, change.oldPath)) {
          nextStats[change.newPath] = nextStats[change.oldPath];
          delete nextStats[change.oldPath];
        }
        return {
          files: state.files.map(path => (path === change.oldPath ? change.newPath : path)),
          statsMap: nextStats,
          listingGeneration: state.listingGeneration + 1,
          fileIsEdited: !state.fileIsEdited,
        };
      });
    } else {
      fileStore.setState(state => ({ listingGeneration: state.listingGeneration + 1, fileIsEdited: !state.fileIsEdited }));
    }
  }
  await invoke("acknowledge_local_move", { sourcePath, destinationPath });
  return warnings;
}
