import "@fontsource/ia-writer-duo";
import "@fontsource/inter";
import "@fontsource/fira-code";
import "@fontsource/jetbrains-mono";
import "@fontsource/roboto";
import "@fontsource/lora";
import "@fontsource/merriweather";
import "@fontsource/open-sans";
import "@fontsource/poppins";
import "@fontsource/montserrat";
import "@fontsource/source-code-pro";
import "@fontsource/space-mono";
import "@fontsource/playfair-display";
import "@fontsource/nunito";
import "@fontsource/cinzel";
import { animated, useSpring } from "@react-spring/web";
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
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
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
    [pageStyles] = useSpring(() => ({
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 200 },
    }));

  useEffect(() => {
    const bg = isDay ? "#e0e0e0" : "#101010";
    (window as any).document.documentElement.style.backgroundColor = bg;
    (window as any).document.body.style.backgroundColor = bg;
    (window as any).document.documentElement.classList.toggle("dark", !isDay);
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
    const handleGlobalMouseMove = (): void => {
      if (document.body.classList.contains("is-typing")) {
        document.body.classList.remove("is-typing");
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
