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
  | "rose";

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

function readMap(key: "folderColors" | "folderIcons"): FolderAppearanceMap {
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

export function getFolderColors(): FolderAppearanceMap {
  return readMap("folderColors");
}

export function getFolderIcons(): FolderAppearanceMap {
  return readMap("folderIcons");
}

export function getFolderColor(path: string): string | undefined {
  return getFolderColors()[path];
}

export function getFolderIcon(path: string): string | undefined {
  return getFolderIcons()[path];
}

export function setFolderColor(path: string, colorKey: string | undefined): void {
  const map = getFolderColors();
  if (!colorKey || colorKey === "default") delete map[path];
  else map[path] = colorKey;
  window.localStorage.setItem("folderColors", JSON.stringify(map));
}

export function setFolderIcon(path: string, iconKey: string | undefined): void {
  const map = getFolderIcons();
  if (!iconKey || iconKey === "default") delete map[path];
  else map[path] = iconKey;
  window.localStorage.setItem("folderIcons", JSON.stringify(map));
}

export function remapFolderAppearance(oldPath: string, newPath: string): void {
  const prefix = `${oldPath}/`;
  const rename = (p: string) => (p === oldPath ? newPath : p.startsWith(prefix) ? `${newPath}${p.slice(oldPath.length)}` : p);
  for (const key of ["folderColors", "folderIcons"] as const) {
    const map = readMap(key);
    let changed = false;
    const next: FolderAppearanceMap = {};
    for (const [p, v] of Object.entries(map)) {
      const rp = rename(p);
      if (rp !== p) changed = true;
      next[rp] = v;
    }
    if (changed) window.localStorage.setItem(key, JSON.stringify(next));
  }
}
