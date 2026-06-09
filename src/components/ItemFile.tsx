import MenuFile from "./MenuFile";
import MenuPaperFile from "./MenuPaperFile";
import useFile from "../hooks/useFile";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { navigation, themes } from "../utils/helpers";
import { PAGES } from "../utils/consts";
import { twMerge } from "tailwind-merge";
import { useState } from "react";
import type { Component, File } from "../utils/types";

function ItemFile({ fileName }: Props): Component {
  const { goTo } = navigation(),
    { isDay } = themes(),
    paperIsOpen = configStore(state => state.paperIsOpen),
    { readFile } = useFile(),
    setSelectedFile = fileStore(state => state.setSelectedFile),
    [hover, setHover] = useState<boolean>(false);

  function getListLabel(name: string): string {
    return name.replace(/\.(txt|md)$/i, "");
  }

  async function openFile(): Promise<void> {
    const fileContent: string = await readFile(fileName);
    const newSelectedFile: File = { name: fileName, content: fileContent };
    setSelectedFile(newSelectedFile);
    goTo(PAGES.file);
  }

  return (
    <li
      onClick={openFile}
      onMouseLeave={() => setHover(false)}
      onMouseEnter={() => setHover(true)}
      className={twMerge(
        isDay
          ? "border-gray-300 bg-white hover:border-gray-400 hover:bg-gray-50 text-gray-800 shadow-sm"
          : "border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-900/95 text-zinc-200",
        "relative flex min-h-[84px] w-full cursor-pointer items-start rounded-[8px] border px-4 py-3 duration-150"
      )}
    >
      <p
        className="w-full text-left font-sans text-[15px] leading-5"
        style={{
          display: "-webkit-box",
          overflow: "hidden",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          textOverflow: "ellipsis",
        }}>
        {getListLabel(fileName)}
      </p>
      {hover && !paperIsOpen && <MenuFile fileName={fileName} />}
      {hover && paperIsOpen && <MenuPaperFile fileName={fileName} />}
    </li>
  );
}

export default ItemFile;

interface Props {
  fileName: string;
}
