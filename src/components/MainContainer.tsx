import "@fontsource/ia-writer-duo/latin.css";
import "@fontsource/inter/latin.css";
import "@fontsource/inter/latin-ext.css";
import "@fontsource/fira-code/latin.css";
import "@fontsource/fira-code/latin-ext.css";
import "@fontsource/jetbrains-mono/latin.css";
import "@fontsource/jetbrains-mono/latin-ext.css";
import "@fontsource/roboto/latin.css";
import "@fontsource/roboto/latin-ext.css";
import "@fontsource/lora/latin.css";
import "@fontsource/lora/latin-ext.css";
import "@fontsource/merriweather/latin.css";
import "@fontsource/merriweather/latin-ext.css";
import "@fontsource/open-sans/latin.css";
import "@fontsource/open-sans/latin-ext.css";
import "@fontsource/poppins/latin.css";
import "@fontsource/poppins/latin-ext.css";
import "@fontsource/montserrat/latin.css";
import "@fontsource/montserrat/latin-ext.css";
import "@fontsource/source-code-pro/latin.css";
import "@fontsource/source-code-pro/latin-ext.css";
import "@fontsource/space-mono/latin.css";
import "@fontsource/space-mono/latin-ext.css";
import "@fontsource/playfair-display/latin.css";
import "@fontsource/playfair-display/latin-ext.css";
import "@fontsource/nunito/latin.css";
import "@fontsource/nunito/latin-ext.css";
import "@fontsource/cinzel/latin.css";
import "@fontsource/cinzel/latin-ext.css";
import { animated, useSpring } from "@react-spring/web";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X } from "lucide-react";
import { useEffect, useState, type PropsWithChildren } from "react";
import { twJoin, twMerge } from "tailwind-merge";
import usePreferences from "../hooks/usePreferences";
import { PAGES } from "../utils/consts";
import { pathIs, themes } from "../utils/helpers";
import type { Component } from "../utils/types";
import Header from "./Header";
import DropOverlay from "./DropOverlay";
import { triggerWindowReady } from "../utils/window";
import { handleExternalFileImport } from "../utils/fileImporter";

async function checkIsFullscreen(): Promise<boolean> {
  try {
    return await getCurrentWebviewWindow().isFullscreen();
  } catch {
    return !!document.fullscreenElement;
  }
}

function MainContainer({ children }: PropsWithChildren): Component {
  const { myFontValue } = usePreferences(),
    { isDay } = themes(),
    [isFullscreen, setIsFullscreen] = useState<boolean>(false),
    [showExitBtn, setShowExitBtn] = useState<boolean>(false),
    [isDraggingOver, setIsDraggingOver] = useState<boolean>(false),
    [pageStyles] = useSpring(() => ({
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 200 },
    }));

  useEffect(() => {
    triggerWindowReady();
  }, []);

  useEffect(() => {
    let unlistenDragDrop: (() => void) | null = null;
    let isMounted = true;

    // Prevenir el comportamiento por defecto de navegación de archivos en el navegador
    const preventDefault = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventDefault);
    window.addEventListener("drop", preventDefault);

    const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
    if (isTauri) {
      void (async () => {
        try {
          const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
            if (!isMounted) return;
            if (event.payload.type === "enter" || event.payload.type === "over") {
              setIsDraggingOver(true);
            } else if (event.payload.type === "leave") {
              setIsDraggingOver(false);
            } else if (event.payload.type === "drop") {
              setIsDraggingOver(false);
              if (event.payload.paths && event.payload.paths.length > 0) {
                void handleExternalFileImport(event.payload.paths);
              }
            }
          });
          if (isMounted) {
            unlistenDragDrop = unlisten;
          } else {
            unlisten();
          }
        } catch (err) {
          console.warn("No se pudo inicializar listener nativo de arrastrar y soltar:", err);
        }
      })();
    }

    return () => {
      isMounted = false;
      window.removeEventListener("dragover", preventDefault);
      window.removeEventListener("drop", preventDefault);
      unlistenDragDrop?.();
    };
  }, []);

  useEffect(() => {
    const bg = isDay ? "#e0e0e0" : "#101010";
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
    document.documentElement.classList.toggle("dark", !isDay);
    document.documentElement.classList.toggle("light", isDay);
  }, [isDay]);

  const toggleFullscreen = async (): Promise<void> => {
    try {
      const appWindow = getCurrentWebviewWindow();
      const isFull = await appWindow.isFullscreen();
      await appWindow.setFullscreen(!isFull);
      setIsFullscreen(!isFull);
    } catch {
      if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen?.();
        setIsFullscreen(true);
      } else {
        void document.exitFullscreen?.();
        setIsFullscreen(false);
      }
    }
    setShowExitBtn(false);
  };

  const handleExitFullscreen = async (): Promise<void> => {
    try {
      const appWindow = getCurrentWebviewWindow();
      await appWindow.setFullscreen(false);
    } catch {
      if (document.fullscreenElement) {
        void document.exitFullscreen?.();
      }
    }
    setIsFullscreen(false);
    setShowExitBtn(false);
  };

  useEffect(() => {
    let isMounted = true;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const syncFullscreenState = async (): Promise<void> => {
      const full = await checkIsFullscreen();
      if (!isMounted) return;
      setIsFullscreen(full);
      if (!full) setShowExitBtn(false);
    };

    void syncFullscreenState();

    const handleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void syncFullscreenState();
      }, 100);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      isMounted = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    const preventContextMenu = (e: Event): void => {
      if (import.meta.env.DEV) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
    };

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
      }
    };

    window.addEventListener("contextmenu", preventContextMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("contextmenu", preventContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) {
      setShowExitBtn(false);
      return;
    }

    const handleMouseMove = (e: MouseEvent): void => {
      if (e.clientY <= 12) {
        setShowExitBtn(true);
      } else if (e.clientY > 65) {
        setShowExitBtn(false);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [isFullscreen]);

  useEffect(() => {
    if (pathIs(PAGES.preferences)) {
      document.documentElement.classList.add("in-preferences");
    } else {
      document.documentElement.classList.remove("in-preferences");
    }
    return () => {
      document.documentElement.classList.remove("in-preferences");
    };
  }, []);

  useEffect(() => {
    if (!pathIs(PAGES.file)) {
      document.body.classList.remove("is-typing");
      return;
    }

    let lastMouseX = -1;
    let lastMouseY = -1;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      // "o sin mover el mouse": si no se mueve el mouse por 2.5s, activar modo zen
      idleTimer = setTimeout(() => {
        if (!document.body.classList.contains("is-typing")) {
          document.body.classList.add("is-typing");
        }
      }, 2500);
    };

    const handleGlobalMouseMove = (e: MouseEvent): void => {
      // Registrar la posición inicial del ratón sin despertar la UI erróneamente
      if (lastMouseX === -1 || lastMouseY === -1) {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        resetIdleTimer();
        return;
      }

      // Si las coordenadas no cambiaron, es un evento sintético de scroll/render: ignorar
      if (e.clientX === lastMouseX && e.clientY === lastMouseY) {
        return;
      }

      const dist = Math.hypot(e.clientX - lastMouseX, e.clientY - lastMouseY);
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;

      // Si el usuario está escribiendo activamente (< 400ms), ignorar
      // micro-movimientos de vibración de teclado o roce involuntario de touchpad (< 8px)
      const lastTyping = window.__lastTypingTime || 0;
      const isActivelyTyping = Date.now() - lastTyping < 400;
      if (isActivelyTyping && dist < 8) {
        return;
      }

      // "apenas se mueve el cursor": despertar de inmediato la interfaz con la transición
      if (document.body.classList.contains("is-typing")) {
        document.body.classList.remove("is-typing");
      }

      resetIdleTimer();
    };

    resetIdleTimer();

    window.addEventListener("mousemove", handleGlobalMouseMove, { passive: true });
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener("mousemove", handleGlobalMouseMove);
    };
  }, []);

  const isPreferences = pathIs(PAGES.preferences);
  const isFile = pathIs(PAGES.file);

  return (
    <main
      className={twMerge(
        isDay ? "bg-[#e0e0e0] text-gray-800" : "bg-[#101010] text-gray-200/90",
        isFile
          ? "gap-0 items-stretch"
          : "gap-y-10 lg:gap-y-20 items-center",
        twJoin(
          myFontValue(),
          isPreferences
            ? "w-full min-h-screen flex flex-col justify-start relative select-none"
            : "w-full h-screen overflow-hidden flex flex-col justify-start relative select-none",
        ),
      )}
    >
      {/* Botón flotante para salir de Pantalla Completa al mover cursor arriba */}
      <div
        className={twMerge(
          "no-print fixed top-3 left-1/2 -translate-x-1/2 z-[99999] transition-all duration-200 ease-out flex items-center justify-center",
          showExitBtn
            ? "opacity-100 translate-y-0 pointer-events-auto"
            : "opacity-0 -translate-y-4 pointer-events-none"
        )}
      >
        <button
          onClick={handleExitFullscreen}
          title="Salir de pantalla completa (F11)"
          aria-label="Salir de pantalla completa (F11)"
          className={twMerge(
            "flex items-center justify-center p-2 rounded-full shadow-lg border backdrop-blur-md transition-all duration-150 hover:scale-110 active:scale-95 cursor-pointer",
            isDay
              ? "bg-white/90 text-gray-800 border-gray-300 hover:bg-white"
              : "bg-neutral-800/90 text-gray-200 border-neutral-700 hover:bg-neutral-800"
          )}
        >
          <X size={16} />
        </button>
      </div>

      <Header />
      <DropOverlay visible={isDraggingOver} />
      {isFile ? (
        <div className="w-full flex-1 flex flex-col items-center justify-start h-full overflow-hidden">
          {children}
        </div>
      ) : (
        <animated.div
          style={pageStyles}
          className={twMerge(
            "w-full flex-1 flex flex-col items-center justify-start",
            !isPreferences && "h-full overflow-hidden"
          )}
        >
          {children}
        </animated.div>
      )}
    </main>
  );
}

export default MainContainer;
