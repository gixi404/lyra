import translations from "../utils/dictionary";
import useStorage from "../hooks/useStorage";
import { animated, useSpring } from "@react-spring/web";
import { ArrowLeftIcon, EyeIcon } from "lucide-react";
import { configStore } from "../store/configStore";
import { Link } from "react-router-dom";
import { navigation, pathIs, themes } from "../utils/helpers";
import { PAGES, THEMES } from "../utils/consts";
import { twJoin, twMerge } from "tailwind-merge";
import { useState } from "react";
import type { Component } from "../utils/types";

function DefaultHeader(): Component {
  const d = translations(),
    { isDay } = themes(),
    { goTo } = navigation(),
    { setItem } = useStorage(),
    { setShowHeader } = configStore(),
    [styles] = useSpring(() => ({ opacity: 1 })),
    [menu, setMenu] = useState<Menu>(initMenu);

  function closeMenu(id: string): void {
    document.getElementById(id)?.removeAttribute("open");
  }

  function closeAllMenus(): void {
    closeMenu("file");
    closeMenu("commands");
    closeMenu("help");
    closeMenu("themes");
    setMenu({ file: false, commands: false, help: false, themes: false });
  }

  function changeTheme(theme: string): void {
    setItem("theme", theme);
    location.reload();
  }

  function toggleMenu(menuId: string): void {
    closeAllMenus();
    setMenu(prevState => ({ ...prevState, [menuId]: true }));
  }

  return (
    <>
      <p className="text-transparent">.</p>
      <animated.header
        style={styles}
        onMouseLeave={closeAllMenus}
        className={twMerge(
          isDay
            ? "bg-gray-300/90 text-black/80 border-[#979797] [&>div>details>summary:hover]:text-black"
            : "bg-[#151515]/90 text-white/70 border-[#252525] [&>div>details>summary:hover]:text-white",
          "select-none text-sm backdrop-blur-sm border-b w-full justify-between items-center flex px-4 h-10 fixed top-0 left-0 z-50 transition-all duration-200"
        )}
      >
        <div className="w-1/6 flex gap-x-3 justify-start items-center">
          <button
            onClick={() => setShowHeader(false)}
            className="p-1.5 rounded-full hover:hover:bg-white/10 transition-colors"
            aria-label="Ocultar header"
          >
            <EyeIcon size={20} color={isDay ? "#1f1f1f9d" : "#ffffff9d"} />
          </button>
          {pathIs(PAGES.file) && (
            <button
              onClick={() => goTo(PAGES.list)}
              className="p-1.5 rounded-full hover:hover:bg-white/10 transition-colors"
              aria-label="Volver a la lista"
            >
              <ArrowLeftIcon size={19} />
            </button>
          )}
        </div>

        <nav className="w-5/6 h-full flex gap-x-8 justify-end items-center">
          <Link
            className={twJoin(
              pathIs(PAGES.list) && "text-white",
              "cursor-default transition-colors hover:text-white"
            )}
            to={PAGES.list}
            onClick={e => {
              if (pathIs(PAGES.list)) {
                e.preventDefault();
              }
            }}
          >
            {d.List}
          </Link>
          <Link
            className={twJoin(
              pathIs(PAGES.preferences) && "text-white",
              "cursor-default transition-colors hover:text-white"
            )}
            to={PAGES.preferences}
            onClick={e => {
              if (pathIs(PAGES.preferences)) {
                e.preventDefault();
              }
            }}
          >
            {d.Preferences}
          </Link>

          <details id="commands" className="relative">
            <summary
              className="transition-colors hover:text-white"
              onClick={() => toggleMenu("commands")}
            >
              {d.Commands}
            </summary>

            {menu.commands && (
              <div
                className={twJoin(
                  // menuStyles,
                  "absolute top-[30px] left-0 border px-4 flex flex-col justify-start items-start w-[360px] py-2 gap-y-3  z-10 -ml-36 bg-[#151515] border-[#383838]"
                )}
              >
                <div className="cursor-default w-full flex justify-between items-center gap-x-4">
                  <p>{d.FullScreen}</p>
                  <kbd> F11</kbd>
                </div>
                <div className="cursor-default w-full flex justify-between items-center gap-x-4">
                  <p>{d.Search}</p>
                  <kbd> CTRL + F</kbd>
                </div>
                <div className="cursor-default w-full flex justify-between items-center gap-x-4">
                  <p>{d.CheckSpelling}</p>
                  <kbd> CTRL + M</kbd>
                </div>
                <div className="cursor-default w-full flex justify-between items-center gap-x-4">
                  <p>{d.ReduceTextSize}</p>
                  <kbd> CTRL + B</kbd>
                </div>
                <div className="cursor-default w-full flex justify-between items-center gap-x-4">
                  <p>{d.IncreaseTextSize}</p>
                  <kbd> CTRL + N</kbd>
                </div>
                <div className="cursor-default w-full flex justify-between items-center gap-x-4">
                  <p>{d.CopyText}</p>
                  <kbd> CTRL + A</kbd>
                </div>
              </div>
            )}
          </details>

          <details id="themes" className="relative group">
            <summary
              className="transition-colors hover:text-white"
              onClick={() => toggleMenu("themes")}
            >
              {d.Themes}
            </summary>

            {menu.themes && (
              <div
                className={twJoin(
                  "absolute top-full mt-2.5 right-0 border border-t-0",
                  "w-44 py-2",
                  isDay
                    ? "bg-gray-300 border-[#979797]"
                    : "bg-[#151515] border-[#383838]"
                )}
              >
                <button
                  onClick={() => changeTheme(THEMES.clearNigth)}
                  className={twJoin(
                    !isDay && "text-white",
                    twMerge(
                      "w-full px-4 py-2 text-left transition-colors",
                      isDay ? "hover:bg-black/5" : "hover:bg-white/5"
                    )
                  )}
                >
                  {d.Night}
                </button>
                <button
                  onClick={() => changeTheme(THEMES.Day)}
                  className={twMerge(
                    "w-full px-4 py-2 text-left transition-colors",
                    isDay ? "hover:bg-black/5" : "hover:bg-white/5"
                  )}
                >
                  {d.Day}
                </button>
              </div>
            )}
          </details>

          <details id="help" className="relative group">
            <summary
              className="transition-colors hover:text-white"
              onClick={() => toggleMenu("help")}
            >
              {d.Help}
            </summary>

            {menu.help && (
              <div
                className={twJoin(
                  "absolute top-full mt-2.5 right-0 border border-t-0",
                  "w-44 py-2",
                  isDay
                    ? "bg-gray-300 border-[#979797]"
                    : "bg-[#151515] border-[#383838]"
                )}
              >
                <button
                  onClick={() => goTo(PAGES.presentation)}
                  className={twJoin(
                    pathIs(PAGES.presentation) && "text-white",
                    twMerge(
                      "w-full px-4 py-2 text-left transition-colors",
                      isDay ? "hover:bg-black/5" : "hover:bg-white/5"
                    )
                  )}
                >
                  {d.About}
                </button>
                <button
                  onClick={() => goTo(PAGES.support)}
                  className={twJoin(
                    pathIs(PAGES.support) && "text-white",
                    twMerge(
                      "w-full px-4 py-2 text-left transition-colors",
                      isDay ? "hover:bg-black/5" : "hover:bg-white/5"
                    )
                  )}
                >
                  {d.Support}
                </button>
                <button
                  onClick={() => goTo(PAGES.myFiles)}
                  className={twJoin(
                    pathIs(PAGES.myFiles) && "text-white",
                    twMerge(
                      "w-full px-4 py-2 text-left transition-colors",
                      isDay ? "hover:bg-black/5" : "hover:bg-white/5"
                    )
                  )}
                >
                  {d.MyFiles}
                </button>
              </div>
            )}
          </details>
        </nav>
      </animated.header>
    </>
  );
}

export default DefaultHeader;

const initMenu: Menu = {
  file: false,
  commands: false,
  help: false,
  themes: false,
};

interface Menu {
  file: boolean;
  commands: boolean;
  help: boolean;
  themes: boolean;
}
