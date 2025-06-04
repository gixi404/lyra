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
      <section className="px-6 md:px-0 w-full max-w-[700px] h-full min-h-[300px] flex flex-col justify-between items-center">
        <div className="w-full flex justify-start items-end">
          <h1
            className={twMerge(
              isDay ? "text-black/90" : "text-gray-200 ",
              "md:text-7xl text-5xl tracking-tight"
            )}
          >
            <span className="text-indigo-500">L</span>y
            <span className="text-indigo-500">r</span>a
            <span className="md:text-4xl text-2xl">:</span>
          </h1>

          <TypingAnimation
            text={d.FocusedWriting}
            className={twMerge(
              isDay ? "text-black/90" : "text-gray-200",
              "md:text-3xl text-lg pb-5"
            )}
          />
          <FeatherIcon />
        </div>

        <ol
          className={twMerge(
            isDay ? "text-black/90" : "text-gray-200",
            "md:text-lg text-md w-full flex justify-start items-center sm:gap-x-3 gap-x-1 [&>span]:text-indigo-500 [&>span]:font-semibold [&>span]:text-2xl"
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
            "flex justify-start gap-x-10 items-center w-full md:text-lg text-md"
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
