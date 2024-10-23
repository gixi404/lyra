import { animated, useSpring } from "@react-spring/web";
import { ArrowLeft, EyeOff as HiddenIcon, Eye as ShowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { twJoin, twMerge } from "tailwind-merge";
import useStorage from "../hooks/useStorage";
import { configStore } from "../store/configStore";
import { PAGES, THEMES } from "../utils/consts";
import translations from "../utils/dictionary";
import { navigation, pathIs, themes } from "../utils/helpers";
import type { Component } from "../utils/types";

function Header(): Component {
  const d = translations(),
    { isDay } = themes(),
    { showHeader, setShowHeader } = configStore(),
    { setItem } = useStorage(),
    { goTo } = navigation(),
    [menu, setMenu] = useState<Menu>(initMenu),
    menuStyles: string = isDay
      ? "bg-gray-300 border-t-gray-300/90 border-[#979797]"
      : "bg-[#151515] border-t-gray-900/90 border-[#383838]",
    [styles, api] = useSpring(() => ({ opacity: 0 }));

  useEffect(() => {
    api.start({
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 200 },
    });
  }, [showHeader]);

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

  return showHeader ? (
    <>
      <p className="text-transparent">.</p>
      <animated.header
        style={styles}
        onMouseLeave={closeAllMenus}
        className={twMerge(
          isDay
            ? "bg-gray-300 text-black/80 border-[#979797] [&>div>details>summary:hover]:text-black"
            : "bg-[#151515] text-white/70 border-[#252525] [&>div>details>summary:hover]:text-white",
          "select-none text-sm cursor-default border-b w-full justify-between items-center flex px-4 h-9 fixed top-0 left-0 z-50"
        )}>
        <div className="flex gap-x-4 justify-start items-center">
          <a
            href={PAGES.list}
            className={twMerge(
              isDay ? "hover:text-black" : "hover:text-white",
              "cursor-default"
            )}>
            {d.List}
          </a>
          <a
            href={PAGES.preferences}
            className={twMerge(
              isDay ? "hover:text-black" : "hover:text-white",
              "cursor-default"
            )}>
            {d.Preferences}
          </a>

          <details id="commands" className="relative">
            <summary onClick={() => toggleMenu("commands")}>
              {d.Commands}
            </summary>

            {menu.commands && (
              <div
                className={twJoin(
                  menuStyles,
                  "absolute top-6 left-0 border px-4 flex flex-col justify-center items-start w-[360px] py-2 gap-y-2 z-10"
                )}>
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

          <details id="themes" className="relative">
            <summary onClick={() => toggleMenu("themes")}>{d.Themes}</summary>

            {menu.themes && (
              <div
                className={twJoin(
                  menuStyles,
                  "absolute top-6 left-0 border px-4 flex flex-col justify-center items-start w-44 py-2 gap-y-2 z-10"
                )}>
                <p
                  onClick={() => changeTheme(THEMES.clearNigth)}
                  className={twMerge(
                    isDay ? "hover:text-gray-500" : "hover:text-white",
                    "cursor-default w-full"
                  )}>
                  {d.Night}
                </p>
                <p
                  onClick={() => changeTheme(THEMES.Day)}
                  className={twMerge(
                    isDay ? "hover:text-gray-500" : "hover:text-white",
                    "cursor-default w-full"
                  )}>
                  {d.Day}
                </p>
              </div>
            )}
          </details>

          <details id="help" className="relative">
            <summary onClick={() => toggleMenu("help")}>{d.Help}</summary>

            {menu.help && (
              <div
                className={twJoin(
                  menuStyles,
                  "absolute top-6 left-0 border px-4 flex flex-col justify-center items-start w-44 py-2 gap-y-2 z-10"
                )}>
                <p
                  onClick={() => goTo(PAGES.presentation)}
                  className={twMerge(
                    isDay ? "hover:text-gray-500" : "hover:text-white",
                    "cursor-default w-full"
                  )}>
                  {d.About}
                </p>
                <p
                  onClick={() => goTo(PAGES.support)}
                  className={twMerge(
                    isDay ? "hover:text-gray-500" : "hover:text-white",
                    "cursor-default w-full"
                  )}>
                  {d.Support}
                </p>
                <p
                  onClick={() => goTo(PAGES.myFiles)}
                  className={twMerge(
                    isDay ? "hover:text-gray-500" : "hover:text-white",
                    "cursor-default w-full"
                  )}>
                  {d.MyFiles}
                </p>
              </div>
            )}
          </details>
        </div>

        <div className="flex gap-x-4 justify-center items-center">
          {pathIs(PAGES.file) && (
            <ArrowLeft size={18} onClick={() => goTo(PAGES.list)} />
          )}
          <ShowIcon
            size={20}
            onClick={() => setShowHeader()}
            color={isDay ? "#1f1f1f9d" : "#ffffff9d"}
            className="cursor-default"
          />
        </div>
      </animated.header>
    </>
  ) : (
    <>
      <p className="text-transparent">.</p>
      <animated.header
        style={styles}
        className="fixed text-[#5e5e5e] top-0 right-0 bg-transparent w-full justify-end items-center flex px-4 h-9 border-b border-transparent gap-x-4 z-50">
        {pathIs(PAGES.file) && (
          <ArrowLeft
            size={18}
            onClick={() => goTo(PAGES.list)}
            color={showHeader ? "#fff" : "#5e5e5e"}
            className="cursor-default"
          />
        )}
        <HiddenIcon
          color={isDay ? "#1f1f1f9d" : "#ffffff29"}
          size={20}
          onClick={() => setShowHeader()}
          className="cursor-default"
        />
      </animated.header>
    </>
  );
}

export default Header;

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
