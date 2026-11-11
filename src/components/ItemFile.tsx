import MenuFile from "./MenuFile.tsx";
import MenuPaperFile from "./MenuPaperFile.tsx";
import useFile from "../hooks/useFile.ts";
import { configStore } from "../store/configStore.ts";
import { fileStore } from "../store/fileStore.ts";
import { navigation, notification, themes } from "../utils/helpers.ts";
import { PAGES } from "../utils/consts.ts";
import { twMerge } from "tailwind-merge";
import type { Component, File } from "../utils/types.ts";
import { getScrollPos, setListScroll } from "../utils/listScroll.ts";
import { noteLabel, noteTitle } from "../utils/noteName.ts";

function ItemFile({ fileName, isExiting = false, folderDepth = 0, onDragStart, onDragEnd, archivedByFolder = false }: Props): Component {
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
      draggable={!paperIsOpen && Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={folderDepth ? { paddingLeft: folderDepth * 20 } : undefined}
      onClick={isExiting ? undefined : openFile}
      className={twMerge(
        "group relative flex items-center justify-between w-full px-1 border-b cursor-pointer select-none",
        "transition-[opacity,transform,max-height,padding,border-color,background-color] duration-200 ease-out motion-reduce:transition-none",
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
      </span>

      <div className="flex items-center gap-x-2 shrink-0">
        {!paperIsOpen && <MenuFile fileName={fileName} />}
        {paperIsOpen && !archivedByFolder && <MenuPaperFile fileName={fileName} />}
      </div>
    </li>
  );
}

export default ItemFile;

interface Props {
  fileName: string;
  isExiting?: boolean;
  folderDepth?: number;
  onDragStart?: (event: React.DragEvent<HTMLLIElement>) => void;
  onDragEnd?: () => void;
  archivedByFolder?: boolean;
}
