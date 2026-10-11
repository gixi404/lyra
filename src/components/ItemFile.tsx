import MenuFile from "./MenuFile";
import MenuPaperFile from "./MenuPaperFile";
import useFile from "../hooks/useFile";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { navigation, themes } from "../utils/helpers";
import { PAGES } from "../utils/consts";
import { twMerge } from "tailwind-merge";
import type { Component, File } from "../utils/types";

function ItemFile({ fileName }: Props): Component {
  const { goTo } = navigation(),
    { isDay } = themes(),
    paperIsOpen = configStore(state => state.paperIsOpen),
    { readFile } = useFile(),
    setSelectedFile = fileStore(state => state.setSelectedFile);

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
      className={twMerge(
        "group relative flex items-center justify-between w-full py-3.5 px-1 border-b cursor-pointer transition-colors duration-150 select-none",
        isDay
          ? "border-neutral-200/80 hover:bg-neutral-100/50 text-neutral-800"
          : "border-zinc-800/60 hover:bg-zinc-900/40 text-zinc-200"
      )}
    >
      <span
        className="text-sm sm:text-[15px] truncate pr-4 text-left font-normal"
        title={getListLabel(fileName)}
      >
        {getListLabel(fileName)}
      </span>

      <div className="flex items-center gap-x-2 shrink-0">
        {!paperIsOpen && <MenuFile fileName={fileName} />}
        {paperIsOpen && <MenuPaperFile fileName={fileName} />}
      </div>
    </li>
  );
}

export default ItemFile;

interface Props {
  fileName: string;
}
