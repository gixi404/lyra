import { useEffect, useRef } from "react";
import usePreferences from "./usePreferences";
import { applyScrollSpeedWheel, DEFAULT_SCROLL_SPEED, type ScrollSpeedState } from "../utils/scrollSpeed";

/**
 * Hook para aplicar velocidad de desplazamiento configurada a un contenedor específico.
 * Requisitos fundamentales:
 * - Con 1.0x (predeterminado) no se adjunta ningún listener; el scroll nativo permanece 100% puro.
 * - Con valores distintos de 1.0x se adjunta un único listener con passive: false para permitir escalado.
 * - Limpieza determinista al cambiar de valor o desmontar para evitar listeners duplicados.
 */
export function useScrollSpeed(containerRef?: React.RefObject<HTMLElement | null> | null): void {
  const { myScrollSpeed } = usePreferences();
  const speed = myScrollSpeed();
  const stateRef = useRef<ScrollSpeedState>({ remainder: 0 });

  useEffect(() => {
    const target: HTMLElement | Window | null = containerRef
      ? containerRef.current ||
        (typeof document !== "undefined"
          ? document.getElementById("lyra-list-scroll-container")
          : null)
      : typeof window !== "undefined"
      ? window
      : null;
    if (!target) return;

    // Con 1.0x no se intercepta ni se adjunta ningún listener wheel
    if (Math.abs(speed - DEFAULT_SCROLL_SPEED) < 0.001) {
      return;
    }

    const state = stateRef.current;
    state.remainder = 0;

    let remainderTimer: ReturnType<typeof setTimeout> | null = null;

    const handleWheel = (e: WheelEvent): void => {
      if (remainderTimer !== null) {
        clearTimeout(remainderTimer);
      }
      remainderTimer = setTimeout(() => {
        state.remainder = 0;
      }, 150);

      applyScrollSpeedWheel(e, target, speed, state);
    };

    target.addEventListener("wheel", handleWheel as EventListener, { passive: false });

    return () => {
      if (remainderTimer !== null) {
        clearTimeout(remainderTimer);
      }
      state.remainder = 0;
      target.removeEventListener("wheel", handleWheel as EventListener);
    };
  }, [containerRef, speed]);
}

export default useScrollSpeed;
