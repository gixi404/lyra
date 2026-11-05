import { FileUp } from "lucide-react";
import { themes } from "../utils/helpers";
import { twMerge } from "tailwind-merge";
import type { Component } from "../utils/types";

interface DropOverlayProps {
  visible: boolean;
}

export function DropOverlay({ visible }: DropOverlayProps): Component {
  const { isDay } = themes();

  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={twMerge(
        "fixed inset-0 z-[99998] pointer-events-none flex items-center justify-center p-6 select-none",
        "transition-all duration-200 ease-out motion-reduce:transition-none",
        isDay
          ? "bg-neutral-100/85 backdrop-blur-sm"
          : "bg-zinc-950/85 backdrop-blur-sm"
      )}
    >
      <div
        className={twMerge(
          "w-full max-w-md p-8 rounded-2xl flex flex-col items-center justify-center text-center gap-y-4 border-2 border-dashed",
          "shadow-2xl transition-transform duration-200 motion-reduce:transition-none",
          isDay
            ? "bg-white/90 border-neutral-400 text-neutral-800 shadow-neutral-300/40"
            : "bg-zinc-900/90 border-zinc-600 text-zinc-100 shadow-black/60"
        )}
      >
        <div
          className={twMerge(
            "p-4 rounded-full",
            isDay ? "bg-neutral-200/70 text-neutral-900" : "bg-zinc-800 text-zinc-200"
          )}
        >
          <FileUp size={40} strokeWidth={1.75} className="animate-pulse motion-reduce:animate-none" />
        </div>

        <div className="flex flex-col gap-y-1">
          <h2 className="text-lg sm:text-xl font-medium tracking-tight">
            Soltar archivos para importar
          </h2>
          <p
            className={twMerge(
              "text-xs sm:text-sm font-normal",
              isDay ? "text-neutral-600" : "text-zinc-400"
            )}
          >
            (se creará una copia del archivo original)
          </p>
        </div>
      </div>
    </div>
  );
}

export default DropOverlay;
