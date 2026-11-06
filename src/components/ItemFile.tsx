import MenuFile from "./MenuFile";
import MenuPaperFile from "./MenuPaperFile";
import useFile from "../hooks/useFile";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { navigation, notification, themes } from "../utils/helpers";
import { PAGES } from "../utils/consts";
import { twMerge } from "tailwind-merge";
import type { Component, File } from "../utils/types";
import { getScrollPos, setListScroll } from "../utils/listScroll";
import { getFileDirectory, noteLabel, noteTitle } from "../utils/noteName";

function ItemFile({ fileName, isExiting = false, isHomonym = false }: Props): Component {
  const { goTo } = navigation(),
    { isDay } = themes(),
    paperIsOpen = configStore(state => state.paperIsOpen),
    { readFile } = useFile(),
    setSelectedFile = fileStore(state => state.setSelectedFile);

  function getListLabel(name: string): string {
    return noteTitle(name);
  }

  async function openFile(): Promise<void> {
    if (isExiting) return;
    try {
      const currentView = paperIsOpen ? "paper" : "active";
      setListScroll(getScrollPos(currentView), currentView);
      const fileContent: string = await readFile(fileName);
      const newSelectedFile: File = { name: fileName, content: fileContent };
      setSelectedFile(newSelectedFile);
      goTo(PAGES.file);
    } catch {
      notification("error", `No se pudo abrir ${noteLabel(fileName)}`);
    }
  }

  return (
    <li
      data-note-name={fileName}
      onClick={isExiting ? undefined : openFile}
      className={twMerge(
        "group relative flex items-center justify-between w-full px-1 border-b cursor-pointer select-none",
        "transition-all duration-200 ease-out motion-reduce:transition-none",
        isExiting
          ? "opacity-0 -translate-y-1.5 scale-[0.98] max-h-0 py-0 border-transparent overflow-hidden pointer-events-none"
          : "opacity-100 transform-none max-h-16 py-3.5",
        isDay
          ? "border-neutral-200/80 hover:bg-neutral-100/50 text-neutral-800"
          : "border-zinc-800/60 hover:bg-zinc-900/40 text-zinc-200"
      )}
    >
      <span
        className="text-sm sm:text-[15px] truncate pr-4 text-left font-normal flex items-center min-w-0"
        title={fileName}
      >
        <span className="truncate">{getListLabel(fileName)}</span>
        {isHomonym && (
          <span
            className={twMerge(
              "text-xs ml-2 font-normal truncate shrink-0 tracking-tight select-none opacity-60",
              isDay ? "text-neutral-500" : "text-zinc-400"
            )}
          >
            {getFileDirectory(fileName) || "lyra"}
          </span>
        )}
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
  isExiting?: boolean;
  isHomonym?: boolean;
}
