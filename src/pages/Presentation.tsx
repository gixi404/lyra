import { useEffect } from "react";
import { twMerge } from "tailwind-merge";
import FeatherIcon from "../components/FeatherIcon";
import MainContainer from "../components/MainContainer";
import TypingAnimation from "../components/TypingAnimation";
import { PAGES } from "../utils/consts";
import translations from "../utils/dictionary";
import {
  featherAnimation,
  navigation,
  themes,
  verifyMainFolder,
  verifySystemLang,
} from "../utils/helpers";
import type { Component } from "../utils/types";

function PresentationPage(): Component {
  const { goTo } = navigation();
  const { isDay } = themes();
  const d = translations();

  useEffect(() => {
    verifyMainFolder();
    verifySystemLang();
    featherAnimation();
  }, []);

  return (
    <MainContainer>
      <section className="px-4 sm:px-6 md:px-0 w-full max-w-[700px] h-full min-h-[300px] flex flex-col justify-between items-center gap-y-6 sm:gap-y-0">
        <div className="w-full flex justify-start items-end">
          <h1
            className={twMerge(
              isDay ? "text-black/90" : "text-gray-200 ",
              "text-4xl sm:text-5xl md:text-7xl tracking-tight"
            )}
          >
            <span className="text-indigo-500">L</span>y
            <span className="text-indigo-500">r</span>a
            <span className="text-xl sm:text-2xl md:text-4xl">:</span>
          </h1>

          <TypingAnimation
            text={d.FocusedWriting}
            className={twMerge(
              isDay ? "text-black/90" : "text-gray-200",
              "text-base sm:text-lg md:text-3xl pb-3 sm:pb-5"
            )}
          />
          <FeatherIcon />
        </div>

        <ol
          className={twMerge(
            isDay ? "text-black/90" : "text-gray-200",
            "text-sm sm:text-md md:text-lg w-full flex justify-start items-center gap-x-1 sm:gap-x-3 [&>span]:text-indigo-500 [&>span]:font-semibold [&>span]:text-lg sm:[&>span]:text-2xl"
          )}
        >
          <li>{d.MinimalDesing}</li>
          <span>-</span>
          <li>{d.OfflineAccess}</li>
          <span>-</span>
          <li>{d.LocalSaved}</li>
        </ol>

        <div className="w-full flex justify-start items-center">
          <button
            onClick={() => goTo(PAGES.list)}
            className="text-xl text-white hover:bg-indigo-500 duration-75 pb-2 pt-1.5 px-6 rounded-lg bg-indigo-600"
          >
            {d.Start}
          </button>
        </div>

        <div
          className={twMerge(
            isDay ? "text-black/90" : "text-gray-400",
            "flex flex-col sm:flex-row justify-start gap-x-4 sm:gap-x-10 gap-y-2 sm:gap-y-0 items-start sm:items-center w-full text-sm sm:text-md md:text-lg"
          )}
        >
          <a
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-default hover:underline"
            href="https://github.com/gixi404/lyra/releases"
          >
            {d.Version}: 2.0.0
          </a>
          <a
            href="https://gixi.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-default hover:underline"
          >
            {d.DevelopedBy}
          </a>
        </div>
      </section>
    </MainContainer>
  );
}

export default PresentationPage;
