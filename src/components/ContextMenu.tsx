import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { MoreVertical, type LucideIcon } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { themes } from "../utils/helpers.ts";
import {
  menuBackgroundColor,
  menuItemClass,
  menuPanelClass,
  menuSeparatorClass,
  menuTriggerClass,
  type MenuReveal,
  type MenuTone,
} from "../utils/menuStyles.ts";
import { computeMenuPosition, anchorHasMoved, isSameMenuPosition, type MenuAlign, type MenuAnchorSnapshot, type MenuPlacement } from "../utils/menuPosition.ts";

/** Ancho real del panel (`w-44` = 11rem). */
const MENU_WIDTH = 176;

/** Altura estimada usada hasta poder medir el panel en pantalla. */
const FALLBACK_MENU_HEIGHT = 200;

/** Mediciones consecutivas sin movimiento tras las cuales el bucle se detiene. */
const IDLE_FRAMES = 2;

/** Cierra el menú padre al elegir una opción. */
const MenuCloseContext = createContext<() => void>(() => undefined);

/**
 * Menú contextual flotante compartido por archivos y carpetas.
 *
 * El panel se renderiza en un portal sobre `document.body` con posicionamiento
 * `fixed`: así no queda recortado por el `overflow` de las carpetas desplegadas
 * ni por los contextos de apilamiento (`transform`) de la lista.
 */
export default function ContextMenu({ children, label, title, reveal = "always", align = "end" }: ContextMenuProps) {
  const { isDay } = themes();
  const [open, setOpen] = useState<boolean>(false);
  const [placement, setPlacement] = useState<MenuPlacement>("bottom");
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [menuHeight, setMenuHeight] = useState<number>(FALLBACK_MENU_HEIGHT);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const transitions = useTransition(open, {
    from: { opacity: 0, transform: `scale(0.96) translateY(${placement === "top" ? "-4px" : "4px"})` },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: `scale(0.96) translateY(${placement === "top" ? "-4px" : "4px"})` },
    config: { duration: 150 },
  });

  const updatePosition = useCallback((preferred?: MenuPlacement, measured?: DOMRect): void => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = measured ?? trigger.getBoundingClientRect();
    const panel = panelRef.current;
    const result = computeMenuPosition({
      anchor: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      menu: {
        width: panel?.offsetWidth || MENU_WIDTH,
        height: panel?.offsetHeight || menuHeight,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      align,
      preferredPlacement: preferred,
    });
    setPosition(previous =>
      isSameMenuPosition(previous, result)
        ? previous
        : { top: result.top, left: result.left }
    );
    setPlacement(result.placement);
  }, [align, menuHeight]);

  function toggle(event: SyntheticEvent): void {
    event.stopPropagation();
    if (!open) {
      // Posición provisional: se calcula antes de abrir para que la animación
      // de entrada arranque en la orientación correcta.
      const trigger = triggerRef.current;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const result = computeMenuPosition({
          anchor: {
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          menu: { width: MENU_WIDTH, height: menuHeight },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          align,
        });
        setPlacement(result.placement);
        setPosition({ top: result.top, left: result.left });
      }
    }
    setOpen(previous => !previous);
  }

  // Medir el panel real y reajustar la posición antes de pintar.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const measured = panel?.offsetHeight ?? 0;
    if (measured && measured !== menuHeight) setMenuHeight(measured);
    updatePosition(placement);
  }, [open, placement, updatePosition, menuHeight]);

  // Seguimiento del ancla. El bucle se detiene por sí solo cuando el elemento
  // permanece inmóvil (dos mediciones consecutivas sin cambios) y se reinicia
  // ante cualquier evento que pueda desplazarlo.
  const followFrameRef = useRef<number | null>(null);
  const stableFramesRef = useRef<number>(0);
  const lastAnchorRef = useRef<MenuAnchorSnapshot | null>(null);
  const placementRef = useRef<MenuPlacement>(placement);

  useEffect(() => {
    placementRef.current = placement;
  }, [placement]);

  const stopFollow = useCallback((): void => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
    stableFramesRef.current = 0;
    lastAnchorRef.current = null;
  }, []);

  const followAnchor = useCallback((): void => {
    if (followFrameRef.current !== null) return;
    const tick = (): void => {
      const trigger = triggerRef.current;
      if (!trigger) {
        followFrameRef.current = null;
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const snapshot: MenuAnchorSnapshot = {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
      const moved = anchorHasMoved(lastAnchorRef.current, snapshot);
      lastAnchorRef.current = snapshot;
      updatePosition(placementRef.current, rect);
      stableFramesRef.current = moved ? 0 : stableFramesRef.current + 1;
      if (stableFramesRef.current >= IDLE_FRAMES) {
        followFrameRef.current = null;
        return;
      }
      followFrameRef.current = requestAnimationFrame(tick);
    };
    followFrameRef.current = requestAnimationFrame(tick);
  }, [updatePosition]);

  // Mantener el menú pegado al ancla: al desplazar la lista, redimensionar la
  // ventana o durante las animaciones de expansión y contracción de carpetas.
  useEffect(() => {
    if (!open) return;
    const handleViewportChange = (): void => {
      updatePosition(placement);
      followAnchor();
    };
    followAnchor();
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    // Los contenedores de las carpetas animan su altura: al cambiar el tamaño de
    // cualquier ancestro el ancla puede desplazarse, así que se vuelve a medir.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => followAnchor()) : null;
    let ancestor: HTMLElement | null = triggerRef.current;
    while (ancestor) {
      observer?.observe(ancestor);
      ancestor = ancestor.parentElement;
    }

    return () => {
      stopFollow();
      observer?.disconnect();
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [open, placement, updatePosition, followAnchor, stopFollow]);

  // Cerrar al hacer clic fuera, al pulsar Escape o al cambiar de contexto.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const originHorizontal = align === "end" ? "right" : "left";

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title ?? label}
        className={menuTriggerClass(isDay, { reveal, open })}
      >
        <MoreVertical size={16} />
      </button>

      {transitions((styles, item) =>
        item && createPortal(
          <animated.div
            ref={panelRef}
            role="menu"
            aria-label={label}
            style={{
              opacity: styles.opacity,
              transform: styles.transform,
              transformOrigin: placement === "top"
                ? `bottom ${originHorizontal}`
                : `top ${originHorizontal}`,
              backgroundColor: menuBackgroundColor(isDay),
              top: position?.top ?? 0,
              left: position?.left ?? 0,
            }}
            onMouseDown={(event: SyntheticEvent) => event.stopPropagation()}
            className={twMerge(menuPanelClass(isDay), "fixed z-[9990]")}
          >
            <MenuCloseContext.Provider value={() => setOpen(false)}>
              {children}
            </MenuCloseContext.Provider>
          </animated.div>,
          document.body
        )
      )}
    </>
  );
}

interface MenuItemProps {
  icon?: LucideIcon;
  label: string;
  onSelect: () => void;
  tone?: MenuTone;
}

/** Opción de un menú contextual. Comparte estilo con archivos y carpetas. */
export function MenuItem({ icon: Icon, label, onSelect, tone = "default" }: MenuItemProps) {
  const { isDay } = themes();
  const closeMenu = useContext(MenuCloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(event: SyntheticEvent) => {
        event.stopPropagation();
        closeMenu();
        onSelect();
      }}
      className={menuItemClass(isDay, tone)}
    >
      {Icon ? <Icon size={14} /> : null}
      <span>{label}</span>
    </button>
  );
}

/** Separador de un menú contextual. */
export function MenuSeparator() {
  const { isDay } = themes();
  return <div role="separator" className={menuSeparatorClass(isDay)} />;
}

interface ContextMenuProps {
  children: ReactNode;
  /** Nombre accesible del disparador y del panel. */
  label: string;
  title?: string;
  /** `hover` oculta el disparador hasta que el elemento recibe hover o foco. */
  reveal?: MenuReveal;
  align?: MenuAlign;
}
