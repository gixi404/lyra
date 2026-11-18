import {
  Folder,
  FolderOpen,
  FolderHeart,
  FolderCog,
  FolderKanban,
  Book,
  BookOpen,
  Briefcase,
  Code,
  Star,
  Heart,
  Music,
  Image,
  FileText,
  Archive,
  Tag,
  Bookmark,
  Flame,
  Lightbulb,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { bindMetadataWithFeedback, metadataMatches, prepareMetadataWrite } from "./metadataIdentity.ts";

export type FolderColorKey =
  | "default"
  | "slate"
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "teal"
  | "blue"
  | "violet"
  | "pink"
  | "lime"
  | "cyan"
  | "indigo"
  | "fuchsia"
  | "rose"
  | "emerald"
  | "sky"
  | "yellow"
  | "stone"
  | "brown";

export interface FolderColorDef {
  key: FolderColorKey;
  label: string;
  /** color for light theme */
  light: string;
  /** color for dark theme */
  dark: string;
  /** swatch bg for picker */
  swatch: string;
}

export const FOLDER_COLORS: FolderColorDef[] = [
  { key: "default", label: "Predeterminado", light: "", dark: "", swatch: "#9ca3af" },
  { key: "slate", label: "Gris", light: "#64748b", dark: "#94a3b8", swatch: "#64748b" },
  { key: "red", label: "Rojo", light: "#dc2626", dark: "#f87171", swatch: "#ef4444" },
  { key: "orange", label: "Naranja", light: "#ea580c", dark: "#fb923c", swatch: "#f97316" },
  { key: "amber", label: "Ámbar", light: "#d97706", dark: "#fbbf24", swatch: "#f59e0b" },
  { key: "green", label: "Verde", light: "#16a34a", dark: "#4ade80", swatch: "#22c55e" },
  { key: "teal", label: "Turquesa", light: "#0d9488", dark: "#2dd4bf", swatch: "#14b8a6" },
  { key: "blue", label: "Azul", light: "#2563eb", dark: "#60a5fa", swatch: "#3b82f6" },
  { key: "violet", label: "Violeta", light: "#7c3aed", dark: "#a78bfa", swatch: "#8b5cf6" },
  { key: "pink", label: "Rosa", light: "#db2777", dark: "#f472b6", swatch: "#ec4899" },
  { key: "lime", label: "Lima", light: "#65a30d", dark: "#a3e635", swatch: "#84cc16" },
  { key: "cyan", label: "Cian", light: "#0891b2", dark: "#22d3ee", swatch: "#06b6d4" },
  { key: "indigo", label: "Índigo", light: "#4f46e5", dark: "#818cf8", swatch: "#6366f1" },
  { key: "fuchsia", label: "Fucsia", light: "#c026d3", dark: "#e879f9", swatch: "#d946ef" },
  { key: "rose", label: "Rosa intenso", light: "#e11d48", dark: "#fb7185", swatch: "#f43f5e" },
  { key: "emerald", label: "Esmeralda", light: "#059669", dark: "#34d399", swatch: "#10b981" },
  { key: "sky", label: "Cielo", light: "#0284c7", dark: "#38bdf8", swatch: "#0ea5e9" },
  { key: "yellow", label: "Amarillo", light: "#ca8a04", dark: "#facc15", swatch: "#eab308" },
  { key: "stone", label: "Piedra", light: "#78716c", dark: "#a8a29e", swatch: "#78716c" },
  { key: "brown", label: "Marrón", light: "#92400e", dark: "#d97706", swatch: "#b45309" },
];

export const FOLDER_COLOR_MAP = new Map(FOLDER_COLORS.map(c => [c.key, c]));

export function resolveFolderColor(key: string | undefined, isDay: boolean): string | undefined {
  if (!key || key === "default") return undefined;
  const def = FOLDER_COLOR_MAP.get(key as FolderColorKey);
  if (!def) return undefined;
  return isDay ? def.light : def.dark;
}

export type FolderIconKey =
  | "default"
  | "folder-open"
  | "folder-heart"
  | "folder-cog"
  | "folder-kanban"
  | "book"
  | "book-open"
  | "briefcase"
  | "code"
  | "star"
  | "heart"
  | "music"
  | "image"
  | "file-text"
  | "archive"
  | "tag"
  | "bookmark"
  | "flame"
  | "lightbulb"
  | "rocket";

export interface FolderIconDef {
  key: FolderIconKey;
  label: string;
  Icon: LucideIcon;
}

export const FOLDER_ICONS: FolderIconDef[] = [
  { key: "default", label: "Predeterminado", Icon: Folder },
  { key: "folder-open", label: "Abierta", Icon: FolderOpen },
  { key: "folder-heart", label: "Favoritos", Icon: FolderHeart },
  { key: "folder-cog", label: "Código", Icon: FolderCog },
  { key: "folder-kanban", label: "Proyecto", Icon: FolderKanban },
  { key: "book", label: "Libro", Icon: Book },
  { key: "book-open", label: "Lectura", Icon: BookOpen },
  { key: "briefcase", label: "Trabajo", Icon: Briefcase },
  { key: "code", label: "Desarrollo", Icon: Code },
  { key: "star", label: "Destacado", Icon: Star },
  { key: "heart", label: "Personal", Icon: Heart },
  { key: "music", label: "Música", Icon: Music },
  { key: "image", label: "Imágenes", Icon: Image },
  { key: "file-text", label: "Notas", Icon: FileText },
  { key: "archive", label: "Archivo", Icon: Archive },
  { key: "tag", label: "Etiqueta", Icon: Tag },
  { key: "bookmark", label: "Marcador", Icon: Bookmark },
  { key: "flame", label: "Importante", Icon: Flame },
  { key: "lightbulb", label: "Ideas", Icon: Lightbulb },
  { key: "rocket", label: "Lanzamiento", Icon: Rocket },
];

export const FOLDER_ICON_MAP = new Map(FOLDER_ICONS.map(i => [i.key, i]));

export function resolveFolderIcon(key: string | undefined): LucideIcon {
  if (!key || key === "default") return Folder;
  return FOLDER_ICON_MAP.get(key as FolderIconKey)?.Icon ?? Folder;
}

export type FolderAppearanceMap = Record<string, string>;

type AppearanceKey = "folderTextColors" | "folderIconColors" | "folderIcons" | "folderColors";

function readRawMap(key: AppearanceKey): FolderAppearanceMap {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: FolderAppearanceMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(key: AppearanceKey, map: FolderAppearanceMap): void {
  window.localStorage.setItem(key, JSON.stringify(map));
}

function migrateLegacyFolderColors(): void {
  try {
    const legacy = readRawMap("folderColors");
    if (Object.keys(legacy).length === 0) return;
    const text = readRawMap("folderTextColors");
    const icon = readRawMap("folderIconColors");
    let changedText = false;
    let changedIcon = false;
    for (const [path, value] of Object.entries(legacy)) {
      if (!(path in text)) { text[path] = value; changedText = true; }
      if (!(path in icon)) { icon[path] = value; changedIcon = true; }
    }
    if (changedText) writeMap("folderTextColors", text);
    if (changedIcon) writeMap("folderIconColors", icon);
    window.localStorage.removeItem("folderColors");
  } catch {
    // ignorar datos corruptos; no bloquear la UI
  }
}

export function getFolderTextColors(): FolderAppearanceMap {
  migrateLegacyFolderColors();
  return Object.fromEntries(Object.entries(readRawMap("folderTextColors")).filter(([path]) => metadataMatches("folder", path)));
}

export function getFolderIconColors(): FolderAppearanceMap {
  migrateLegacyFolderColors();
  return Object.fromEntries(Object.entries(readRawMap("folderIconColors")).filter(([path]) => metadataMatches("folder", path)));
}

/** @deprecated compat: devuelve el mapa de colores de texto (antes color único). */
export function getFolderColors(): FolderAppearanceMap {
  return getFolderTextColors();
}

export function getFolderIcons(): FolderAppearanceMap {
  return Object.fromEntries(Object.entries(readRawMap("folderIcons")).filter(([path]) => metadataMatches("folder", path)));
}

export function getFolderTextColor(path: string): string | undefined {
  return getFolderTextColors()[path];
}

export function getFolderIconColor(path: string): string | undefined {
  return getFolderIconColors()[path];
}

/** @deprecated compat: antes devolvía el color único; ahora el de texto. */
export function getFolderColor(path: string): string | undefined {
  return getFolderTextColor(path);
}

export function getFolderIcon(path: string): string | undefined {
  return getFolderIcons()[path];
}

export function setFolderTextColor(path: string, colorKey: string | undefined): void {
  if (colorKey && colorKey !== "default") prepareMetadataWrite("folder", path);
  migrateLegacyFolderColors();
  const map = readRawMap("folderTextColors");
  if (!colorKey || colorKey === "default") delete map[path];
  else map[path] = colorKey;
  writeMap("folderTextColors", map);
  if (colorKey && colorKey !== "default") bindMetadataWithFeedback("folder", path);
}

export function setFolderIconColor(path: string, colorKey: string | undefined): void {
  if (colorKey && colorKey !== "default") prepareMetadataWrite("folder", path);
  migrateLegacyFolderColors();
  const map = readRawMap("folderIconColors");
  if (!colorKey || colorKey === "default") delete map[path];
  else map[path] = colorKey;
  writeMap("folderIconColors", map);
  if (colorKey && colorKey !== "default") bindMetadataWithFeedback("folder", path);
}

/** @deprecated compat: aplica el mismo color a texto e icono. */
export function setFolderColor(path: string, colorKey: string | undefined): void {
  setFolderTextColor(path, colorKey);
  setFolderIconColor(path, colorKey);
}

export function setFolderIcon(path: string, iconKey: string | undefined): void {
  if (iconKey && iconKey !== "default") prepareMetadataWrite("folder", path);
  const map = getFolderIcons();
  if (!iconKey || iconKey === "default") delete map[path];
  else map[path] = iconKey;
  writeMap("folderIcons", map);
  if (iconKey && iconKey !== "default") bindMetadataWithFeedback("folder", path);
}

function remapSingleMap(key: AppearanceKey, oldPath: string, newPath: string): boolean {
  const prefix = `${oldPath}/`;
  const rename = (p: string) => (p === oldPath ? newPath : p.startsWith(prefix) ? `${newPath}${p.slice(oldPath.length)}` : p);
  const map = readRawMap(key);
  let changed = false;
  const next: FolderAppearanceMap = {};
  for (const [p, v] of Object.entries(map)) {
    const rp = rename(p);
    if (rp !== p) changed = true;
    next[rp] = v;
  }
  if (changed) writeMap(key, next);
  return changed;
}

export function remapFolderAppearance(oldPath: string, newPath: string): void {
  migrateLegacyFolderColors();
  for (const key of ["folderTextColors", "folderIconColors", "folderIcons", "folderColors"] as const) {
    try { remapSingleMap(key, oldPath, newPath); } catch { /* ignorar */ }
  }
}
