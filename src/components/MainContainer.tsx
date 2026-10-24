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
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X } from "lucide-react";
import { useEffect, useState, type PropsWithChildren } from "react";
import { twJoin, twMerge } from "tailwind-merge";
import usePreferences from "../hooks/usePreferences";
import { PAGES } from "../utils/consts";
import { pathIs, themes } from "../utils/helpers";
import type { Component } from "../utils/types";
import Header from "./Header";

async function checkIsFullscreen(): Promise<boolean> {
  try {
    return await getCurrentWebviewWindow().isFullscreen();
  } catch {
    return !!document.fullscreenElement;
  }
}

let hasShownWindow = false;

async function showAppWindow(): Promise<void> {
  if (hasShownWindow) return;
  hasShownWindow = true;
  try {
    await invoke("show_main_window");
  } catch {
    try {
      const appWindow = getCurrentWebviewWindow();
      await appWindow.show();
      await appWindow.setFocus();
      await appWindow.setResizable(false);
      await appWindow.setResizable(true);
    } catch {
      // Outside Tauri
    }
  }
}

function MainContainer({ children }: PropsWithChildren): Component {
  const { myFontValue } = usePreferences(),
    { isDay } = themes(),
    [isFullscreen, setIsFullscreen] = useState<boolean>(false),
    [showExitBtn, setShowExitBtn] = useState<boolean>(false),
    [pageStyles] = useSpring(() => ({
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 200 },
    }));

  useEffect(() => {
    const timer = setTimeout(() => {
      void showAppWindow();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const bg = isDay ? "#e0e0e0" : "#101010";
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
    document.documentElement.classList.toggle("dark", !isDay);
  }, [isDay]);

  const toggleFullscreen = async (): Promise<void> => {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
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
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
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
    const syncFullscreenState = async (): Promise<void> => {
      const full = await checkIsFullscreen();
      if (!isMounted) return;
      setIsFullscreen(full);
      if (!full) setShowExitBtn(false);
    };

    void syncFullscreenState();

    const handleResize = (): void => {
      void syncFullscreenState();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      isMounted = false;
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
    if (pathIs(PAGES.file)) {
      document.documentElement.classList.add("in-editor");
    } else {
      document.documentElement.classList.remove("in-editor");
    }
    return () => {
      document.documentElement.classList.remove("in-editor");
    };
  }, []);

  useEffect(() => {
    let lastMouseX = -1;
    let lastMouseY = -1;

    const handleGlobalMouseMove = (e: MouseEvent): void => {
      // Ignorar micro-movimientos de trackpad o eventos sintéticos durante re-render
      if (lastMouseX !== -1 && lastMouseY !== -1) {
        const dist = Math.hypot(e.clientX - lastMouseX, e.clientY - lastMouseY);
        if (dist < 6) return;
      }
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;

      // Si el usuario estuvo escribiendo hace menos de 600ms, mantener el modo zen
      const lastTyping = (window as any).__lastTypingTime || 0;
      if (Date.now() - lastTyping < 600) {
        return;
      }

      if (document.documentElement.classList.contains("is-typing")) {
        document.documentElement.classList.remove("is-typing");
      }
      if (document.body.classList.contains("is-typing")) {
        document.body.classList.remove("is-typing");
      }
      const editorTa = document.querySelector(".editor-textarea");
      if (editorTa && editorTa.classList.contains("is-typing-editor")) {
        editorTa.classList.remove("is-typing-editor");
      }
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    return () => window.removeEventListener("mousemove", handleGlobalMouseMove);
  }, []);

  return (
    <main
      className={twMerge(
        isDay ? "bg-[#e0e0e0] text-gray-800" : "bg-[#101010] text-gray-200/90",
        pathIs(PAGES.file)
          ? "gap-0 items-stretch"
          : "gap-y-10 lg:gap-y-20 items-center",
        twJoin(
          myFontValue(),
          "w-full min-h-screen flex flex-col justify-start",
        ),
      )}
    >
      {/* Botón flotante para salir de Pantalla Completa al mover cursor arriba */}
      <div
        className={twMerge(
          "auto-hide-ui no-print fixed top-3 left-1/2 -translate-x-1/2 z-[99999] transition-all duration-200 ease-out flex items-center justify-center",
          showExitBtn
            ? "opacity-100 translate-y-0 pointer-events-auto"
            : "opacity-0 -translate-y-4 pointer-events-none"
        )}
      >
        <button
          onClick={handleExitFullscreen}
          title="Salir de pantalla completa"
          aria-label="Salir de pantalla completa"
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
      <animated.div style={pageStyles} className="w-full flex-1 flex flex-col items-center justify-start">
        {children}
      </animated.div>
    </main>
  );
}

export default MainContainer;
