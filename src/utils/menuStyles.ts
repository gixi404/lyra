import { twMerge } from "tailwind-merge";

// Estilos compartidos por los menús contextuales de archivos y de carpetas.
// Los menús de archivos son la referencia visual: las carpetas reutilizan estas
// clases para que ambos menús sean indistinguibles.

export type MenuTone = "default" | "danger" | "success";

export type MenuReveal = "always" | "hover";

export function menuBackgroundColor(isDay: boolean): string {
  return isDay ? "#ffffff" : "#18181b";
}

export function menuPanelClass(isDay: boolean): string {
  return twMerge(
    "w-44 rounded-xl border py-1 flex flex-col text-xs font-medium",
    isDay
      ? "border-neutral-200 text-neutral-700 shadow-xl shadow-neutral-400/30"
      : "border-zinc-700 text-zinc-200 shadow-2xl shadow-black/80"
  );
}

export function menuItemClass(isDay: boolean, tone: MenuTone = "default"): string {
  const toneClass = tone === "danger"
    ? isDay
      ? "hover:bg-danger-subtle hover:text-danger-text"
      : "hover:bg-rose-500/20 hover:text-rose-400"
    : tone === "success"
      ? isDay
        ? "hover:bg-emerald-50 hover:text-emerald-600"
        : "hover:bg-emerald-500/20 hover:text-emerald-400"
      : isDay
        ? "hover:bg-neutral-100 hover:text-accent-text"
        : "hover:bg-zinc-800 hover:text-sky-400";
  return twMerge(
    "flex items-center gap-x-2.5 px-3 py-2 text-left transition-colors w-full cursor-pointer",
    toneClass
  );
}

export function menuSeparatorClass(isDay: boolean): string {
  return twMerge("my-1 border-t", isDay ? "border-neutral-100" : "border-zinc-800/80");
}

/**
 * Disparador de tres puntos.
 * `reveal: "hover"` lo mantiene oculto hasta que el elemento recibe hover o foco
 * (sin alterar el flujo del documento), `reveal: "always"` lo deja siempre visible.
 */
export function menuTriggerClass(
  isDay: boolean,
  options: { reveal?: MenuReveal; open?: boolean } = {}
): string {
  const { reveal = "always", open = false } = options;
  return twMerge(
    "p-1 rounded-md transition-[opacity,transform,color,background-color,box-shadow] duration-150 active:scale-95 cursor-pointer flex items-center justify-center",
    "focus-visible:outline-none focus-visible:ring-1",
    isDay
      ? "text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200/50 focus-visible:ring-neutral-400"
      : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 focus-visible:ring-zinc-600",
    reveal === "hover"
      ? "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
      : "",
    open ? "opacity-100" : ""
  );
}
