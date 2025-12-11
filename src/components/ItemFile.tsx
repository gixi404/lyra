import MenuFile from "./MenuFile";
import MenuPaperFile from "./MenuPaperFile";
import useFile from "../hooks/useFile";
import { ChevronRight } from "lucide-react";
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
    { paperIsOpen } = configStore(),
    { readFile } = useFile(),
    { setSelectedFile } = fileStore(),
    [hover, setHover] = useState<boolean>(false);

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
          ? "border-gray-400 bg-white hover:bg-gray-50 text-gray-800 shadow-sm"
          : "bg-gray-800/60 hover:bg-gray-800 text-gray-300 border-sky-200/5",
        "w-full max-w-[340px] h-12 rounded-md px-3 hover:cursor-pointer duration-75 flex justify-between items-center bg-gradient-to-b border-2 gap-x-3 relative"
      )}
    >
      <ChevronRight size={24} color="#94a3b8" />
      <p className="text-md w-full text-start overflow-ellipsis overflow-hidden whitespace-nowrap">
        {fileName}
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
