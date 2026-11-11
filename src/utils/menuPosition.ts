// Posicionamiento puro de menús flotantes.
// Se mantiene libre de React y del DOM para poder verificarlo con pruebas unitarias.

export interface MenuAnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export type MenuPlacement = "top" | "bottom";

export type MenuAlign = "start" | "end";

export interface MenuPositionOptions {
  /** Rectángulo del elemento que abrió el menú (coordenadas de viewport). */
  anchor: MenuAnchorRect;
  /** Tamaño medido del panel del menú. */
  menu: MenuSize;
  /** Tamaño visible del viewport. */
  viewport: MenuSize;
  /** Separación entre el ancla y el menú. */
  offset?: number;
  /** Margen mínimo respecto a los bordes del viewport. */
  padding?: number;
  /** Alineación horizontal del panel respecto al ancla. */
  align?: MenuAlign;
  /** Colocación deseada; se mantiene salvo que el menú no quepa en ese lado. */
  preferredPlacement?: MenuPlacement;
}

export interface MenuPositionResult {
  top: number;
  left: number;
  placement: MenuPlacement;
  /** Indica que el panel hubo que desplazarlo horizontalmente para no salirse. */
  shifted: boolean;
}

/** Instantánea mínima del ancla para detectar si se ha movido. */
export interface MenuAnchorSnapshot {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const MENU_OFFSET = 4;

export const MENU_PADDING = 8;

/** Indica si el ancla ha cambiado de posición entre dos mediciones. */
export function anchorHasMoved(
  previous: MenuAnchorSnapshot | null,
  next: MenuAnchorSnapshot
): boolean {
  if (!previous) return true;
  return previous.top !== next.top
    || previous.bottom !== next.bottom
    || previous.left !== next.left
    || previous.right !== next.right;
}

/** Indica si dos posiciones del panel son equivalentes (evita re-renderizados). */
export function isSameMenuPosition(
  previous: { top: number; left: number } | null,
  next: { top: number; left: number }
): boolean {
  return previous !== null && previous.top === next.top && previous.left === next.left;
}

/**
 * Calcula la posición del panel en coordenadas de viewport.
 * El menú se coloca debajo del ancla cuando hay espacio y se voltea hacia arriba
 * cuando no cabe, sin salirse nunca de los límites visibles.
 */
export function computeMenuPosition(options: MenuPositionOptions): MenuPositionResult {
  const { anchor, menu, viewport } = options;
  const offset = options.offset ?? MENU_OFFSET;
  const padding = options.padding ?? MENU_PADDING;
  const align = options.align ?? "end";

  const spaceBelow = viewport.height - anchor.bottom - offset - padding;
  const spaceAbove = anchor.top - offset - padding;
  const fitsBelow = spaceBelow >= menu.height;
  const fitsAbove = spaceAbove >= menu.height;

  let placement: MenuPlacement;
  if (options.preferredPlacement === "top") {
    placement = fitsAbove || (!fitsBelow && spaceAbove >= spaceBelow) ? "top" : "bottom";
  } else if (options.preferredPlacement === "bottom") {
    placement = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove) ? "bottom" : "top";
  } else {
    placement = fitsBelow
      ? "bottom"
      : fitsAbove
        ? "top"
        : spaceBelow >= spaceAbove
          ? "bottom"
          : "top";
  }

  const rawTop = placement === "bottom"
    ? anchor.bottom + offset
    : anchor.top - offset - menu.height;
  const maxTop = Math.max(padding, viewport.height - menu.height - padding);
  const top = Math.min(Math.max(rawTop, padding), maxTop);

  const rawLeft = align === "end" ? anchor.right - menu.width : anchor.left;
  const maxLeft = Math.max(padding, viewport.width - menu.width - padding);
  const left = Math.min(Math.max(rawLeft, padding), maxLeft);

  return { top, left, placement, shifted: left !== rawLeft };
}
