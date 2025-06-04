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
          className="p-1.5 rounded-full hover:hover:bg-white/10 transition-colors"
          aria-label="Ocultar header"
        >
          <EyeOffIcon
            size={19}
            opacity={0.6}
            color={isDay ? "#1f1f1f9d" : "#ffffff9d"}
          />
        </button>
        {pathIs(PAGES.file) && (
          <button
            onClick={() => goTo(PAGES.list)}
            className="p-1.5 rounded-full hover:hover:bg-white/10 transition-colors"
            aria-label="Volver a la lista"
          >
            <ArrowLeftIcon
              color={isDay ? "#1f1f1f9d" : "#ffffff9d"}
              size={20}
              opacity={0.6}
            />
          </button>
        )}
      </animated.header>
    </>
  );
}

export default HiddenHeader;
