import { animated, useSpring } from "@react-spring/web";
import { ArrowLeftIcon, EyeOffIcon } from "lucide-react";
import { configStore } from "../store/configStore";
import { navigation, pathIs, themes } from "../utils/helpers";
import { PAGES } from "../utils/consts";
import type { Component } from "../utils/types";

function HiddenHeader(): Component {
  const { isDay } = themes(),
    { goTo } = navigation(),
    { setShowHeader } = configStore(),
    [styles] = useSpring(() => ({
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 50 },
    }));

  return (
    <>
      <p className="text-transparent">.</p>
      <animated.header
        style={styles}
        className="fixed text-[#5e5e5e] top-0 left-0 bg-transparent w-full justify-start items-center flex px-4 h-10 gap-x-3 z-50"
      >
        <button
          onClick={() => setShowHeader(true)}
          className={`p-1.5 rounded-xl transition-colors shadow-xs border cursor-pointer ${
            isDay
              ? "bg-white/80 border-neutral-300/80 text-neutral-600 hover:text-neutral-900 hover:bg-white"
              : "bg-zinc-900/80 border-zinc-700/80 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
          }`}
          aria-label="Ocultar header"
          title="Ocultar barra de herramientas"
        >
          <EyeOffIcon size={18} />
        </button>
        {pathIs(PAGES.file) && (
          <button
            onClick={() => goTo(PAGES.list)}
            className={`p-1.5 rounded-xl transition-colors shadow-xs border cursor-pointer ${
              isDay
                ? "bg-white/80 border-neutral-300/80 text-neutral-600 hover:text-neutral-900 hover:bg-white"
                : "bg-zinc-900/80 border-zinc-700/80 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            }`}
            aria-label="Volver a la lista"
            title="Volver a la lista"
          >
            <ArrowLeftIcon size={18} />
          </button>
        )}
      </animated.header>
    </>
  );
}

export default HiddenHeader;
