import { invoke } from "@tauri-apps/api/core";
import { configStore } from "../store/configStore.ts";
import { scheduleSavePersistentPreferences } from "./persistentPreferences.ts";
import { useToastStore } from "../store/toastStore.ts";

export type MetadataKind = "file" | "folder";
const KEY = "metadataIdentityBindings";
const HISTORY_KEY = "metadataIdentityHistory";
type Bindings = Record<string, string>;
let live = new Map<string, string>();
let refreshVersion = 0;
const pendingBindings = new Set<string>();

const entryKey = (kind: MetadataKind, path: string) => `${kind}:${path}`;
const inTauri = () => typeof window !== "undefined"
  && !(window as Window & { __LYRA_METADATA_TEST_BYPASS__?: boolean }).__LYRA_METADATA_TEST_BYPASS__
  && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

function readBindings(): Bindings {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      /^(file|folder):/.test(key) && typeof value === "string" && value.length > 0)) as Bindings;
  } catch { return {}; }
}

function writeBindings(value: Bindings): void {
  window.localStorage.setItem(KEY, JSON.stringify(value));
  scheduleSavePersistentPreferences();
}

function archiveAmbiguousMetadata(kind: MetadataKind, path: string, oldId: string): void {
  const keys = kind === "file" ? ["noteVisibleNames"]
    : ["folderVisibleNames", "folderColors", "folderTextColors", "folderIconColors", "folderIcons"];
  let history: Record<string, Record<string, string>> = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) history = parsed as typeof history;
  } catch { /* preserve existing raw maps below */ }
  const archived: Record<string, string> = {};
  for (const key of keys) {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const map = parsed as Record<string, unknown>;
      if (typeof map[path] !== "string") continue;
      archived[key] = map[path] as string;
    } catch { /* retain corrupt raw data */ }
  }
  if (kind === "folder") {
    try {
      const expanded = JSON.parse(window.localStorage.getItem("folderExpanded") ?? "{}") as Record<string, unknown>;
      if (typeof expanded[path] === "boolean") archived.folderExpanded = JSON.stringify(expanded[path]);
    } catch { /* retain corrupt raw data */ }
  }
  const orderKey = kind === "file" ? "fileOrder" : "folderOrder";
  try {
    const order = JSON.parse(window.localStorage.getItem(orderKey) ?? "{}") as Record<string, unknown>;
    const affected: Record<string, unknown> = {};
    for (const [parent, entries] of Object.entries(order)) {
      if (parent === path || (Array.isArray(entries) && entries.includes(path))) affected[parent] = entries;
    }
    if (Object.keys(affected).length > 0) archived[orderKey] = JSON.stringify(affected);
  } catch { /* retain corrupt raw data */ }
  if (Object.keys(archived).length === 0) return;
  history[`${entryKey(kind, path)}:${oldId}`] = archived;
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  for (const key of Object.keys(archived)) {
    if (key === "folderExpanded") {
      const map = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, boolean>;
      delete map[path];
      window.localStorage.setItem(key, JSON.stringify(map));
      continue;
    }
    if (key === "fileOrder" || key === "folderOrder") {
      const map = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, string[]>;
      delete map[path];
      for (const [parent, entries] of Object.entries(map)) {
        if (Array.isArray(entries)) map[parent] = entries.filter(entry => entry !== path);
      }
      window.localStorage.setItem(key, JSON.stringify(map));
      continue;
    }
    const map = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, string>;
    delete map[path];
    window.localStorage.setItem(key, JSON.stringify(map));
  }
  scheduleSavePersistentPreferences();
}

export function prepareMetadataWrite(kind: MetadataKind, path: string): void {
  if (!inTauri() || path === "") return;
  const key = entryKey(kind, path);
  if (pendingBindings.has(key)) return;
  const bindings = readBindings();
  const oldId = bindings[key];
  if (oldId && live.get(key) === oldId) return;
  archiveAmbiguousMetadata(kind, path, oldId ?? "legacy");
  if (oldId) { delete bindings[key]; writeBindings(bindings); }
  pendingBindings.add(key);
}

export function metadataMatches(kind: MetadataKind, path: string): boolean {
  if (!inTauri()) return true;
  const key = entryKey(kind, path);
  if (key === "folder:") return true;
  const expected = readBindings()[key];
  return Boolean(expected && live.get(key) === expected);
}

export function hasMetadataBinding(kind: MetadataKind, path: string): boolean {
  return Boolean(readBindings()[entryKey(kind, path)]);
}

export async function bindMetadata(kind: MetadataKind, path: string): Promise<boolean> {
  if (!inTauri()) return true;
  const key = entryKey(kind, path);
  let identity: string | null;
  try { identity = await invoke<string | null>("metadata_identity", { kind, path, create: true, legacy: false }); }
  catch (error) { pendingBindings.delete(key); throw error; }
  if (!identity) { pendingBindings.delete(key); return false; }
  const bindings = readBindings();
  if (bindings[key] && bindings[key] !== identity) archiveAmbiguousMetadata(kind, path, bindings[key]);
  bindings[key] = identity;
  try { writeBindings(bindings); }
  catch (error) { pendingBindings.delete(key); throw error; }
  live.set(key, identity);
  pendingBindings.delete(key);
  configStore.getState().bumpPrefTick();
  return true;
}

export function bindMetadataWithFeedback(kind: MetadataKind, path: string): void {
  void bindMetadata(kind, path).then(ok => {
    if (!ok) useToastStore.getState().addToast("error", "No se pudo verificar la identidad del elemento. Su personalización se conservó para recuperarla.");
  }).catch(() => {
    useToastStore.getState().addToast("error", "No se pudo guardar la personalización. Los datos se conservaron para reintentar.");
  });
}

export async function refreshMetadataIdentities(files: readonly string[], folders: readonly string[]): Promise<void> {
  if (!inTauri()) return;
  const version = ++refreshVersion;
  const bindings = readBindings();
  const legacyPaths = new Set<string>();
  const addLegacy = (kind: MetadataKind, path: string) => legacyPaths.add(entryKey(kind, path));
  const readRaw = (key: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  };
  for (const path of Object.keys(readRaw("noteVisibleNames"))) addLegacy("file", path);
  for (const key of ["folderVisibleNames", "folderColors", "folderTextColors", "folderIconColors", "folderIcons", "folderExpanded"]) {
    for (const path of Object.keys(readRaw(key))) if (path !== "root:lyra") addLegacy("folder", path);
  }
  for (const [kind, storageKey] of [["file", "fileOrder"], ["folder", "folderOrder"]] as const) {
    for (const entries of Object.values(readRaw(storageKey))) {
      if (Array.isArray(entries)) for (const path of entries) if (typeof path === "string") addLegacy(kind, path);
    }
  }
  const paths: Array<[MetadataKind, string]> = [
    ...files.map(path => ["file", path] as [MetadataKind, string]),
    ...folders.map(path => ["folder", path] as [MetadataKind, string]),
  ].filter(([kind, path]) => Boolean(bindings[entryKey(kind, path)] || legacyPaths.has(entryKey(kind, path))));
  const results = await Promise.all(paths.map(async ([kind, path]) => {
    const isLegacy = !bindings[entryKey(kind, path)];
    try { return await invoke<string | null>("metadata_identity", { kind, path, create: isLegacy, legacy: isLegacy }); }
    catch { return null; }
  }));
  if (version !== refreshVersion) return;
  const next = new Map<string, string>();
  paths.forEach(([kind, path], index) => { if (results[index]) next.set(entryKey(kind, path), results[index]); });
  for (let index = 0; index < paths.length; index++) {
    const [kind, path] = paths[index];
    const key = entryKey(kind, path);
    if (bindings[key] && results[index] && results[index] !== bindings[key]) archiveAmbiguousMetadata(kind, path, bindings[key]);
  }
  const consolidated = { ...bindings };
  for (let index = 0; index < paths.length; index++) {
    const [kind, path] = paths[index];
    const key = entryKey(kind, path);
    const identity = results[index];
    if (!consolidated[key] && identity) consolidated[key] = identity;
  }
  if (JSON.stringify(consolidated) !== JSON.stringify(bindings)) {
    try { writeBindings(consolidated); }
    catch { return; }
  }
  if (JSON.stringify([...live]) !== JSON.stringify([...next])) {
    live = next;
    configStore.getState().bumpPrefTick();
  }
}

export function remapMetadataBindings(changes: ReadonlyArray<{ oldPath: string; newPath: string }>, folderMove?: { oldPath: string; newPath: string }): void {
  const remap = (path: string) => {
    if (folderMove && (path === folderMove.oldPath || path.startsWith(`${folderMove.oldPath}/`))) {
      return `${folderMove.newPath}${path.slice(folderMove.oldPath.length)}`;
    }
    return changes.find(change => change.oldPath === path)?.newPath ?? path;
  };
  const old = readBindings();
  const next: Bindings = {};
  const nextLive = new Map<string, string>();
  for (const [key, id] of Object.entries(old)) {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator) as MetadataKind;
    const path = key.slice(separator + 1);
    const mapped = entryKey(kind, remap(path));
    next[mapped] = id;
    if (live.get(key) === id) nextLive.set(mapped, id);
  }
  if (JSON.stringify(old) !== JSON.stringify(next)) writeBindings(next);
  live = nextLive;
}

export function forgetMetadataBinding(kind: MetadataKind, path: string): void {
  const key = entryKey(kind, path);
  const bindings = readBindings();
  if (key in bindings) { delete bindings[key]; writeBindings(bindings); }
  live.delete(key);
}

export function archiveMetadataForReplacement(kind: MetadataKind, path: string): void {
  if (!inTauri()) return;
  const bindings = readBindings();
  const key = entryKey(kind, path);
  archiveAmbiguousMetadata(kind, path, bindings[key] ?? "legacy");
  if (key in bindings) { delete bindings[key]; writeBindings(bindings); }
  live.delete(key);
  pendingBindings.delete(key);
}
