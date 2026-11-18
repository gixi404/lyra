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
import { displayNoteLabel, displayNoteName } from "../utils/visibleNames.ts";
import { searchStore } from "../store/searchStore.ts";
import { getHighlightSegments, hasNormalizedMatch } from "../utils/searchHighlight.ts";
import { scrollDebug, snapshotScrollState } from "../utils/scrollDebug.ts";

function ItemFile({ fileName, isExiting = false, folderDepth = 0, onDragStart, onDragEnd, archivedByFolder = false, individuallyArchived = true, needsRecoveryDestination = false }: Props): Component {
  const { goTo } = navigation(),
    { isDay } = themes(),
    paperIsOpen = configStore(state => state.paperIsOpen),
    { readFile } = useFile(),
    setSelectedFile = fileStore(state => state.setSelectedFile),
    search = searchStore(state => state.search);

  const visibleName = displayNoteName(fileName);
  const shouldHighlightVisible = search.trim().length > 0 && hasNormalizedMatch(visibleName, search);
  const labelSegments = shouldHighlightVisible
    ? getHighlightSegments(visibleName, search)
    : [{ text: visibleName, highlight: false }];

  async function openFile(): Promise<void> {
    if (isExiting) return;
    try {
      const currentView = paperIsOpen ? "paper" : "active";
      const scrollBefore = getScrollPos(currentView);
      setListScroll(scrollBefore, currentView);
      scrollDebug("ItemFile.openExisting.beforeNavigate", {
        fileName,
        view: currentView,
        scrollBeforeNavigate: scrollBefore,
        storedScroll: getScrollPos(currentView),
      });
      snapshotScrollState("ItemFile.openExisting.beforeNavigate", { fileName, view: currentView });
      const fileContent: string = await readFile(fileName);
      const newSelectedFile: File = { name: fileName, content: fileContent };
      setSelectedFile(newSelectedFile);
      goTo(PAGES.file);
    } catch {
      notification("error", `No se pudo abrir ${displayNoteLabel(fileName)}`);
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
        data-explorer-name
        className="text-sm sm:text-[15px] truncate pr-4 text-left font-normal flex items-center min-w-0"
        title={visibleName}
      >
        <span className="truncate">
          {labelSegments.map((segment, index) =>
            segment.highlight ? (
              <mark key={index} className="bg-yellow-300 text-black rounded-[1px] p-0 m-0">{segment.text}</mark>
            ) : (
              <span key={index}>{segment.text}</span>
            )
          )}
        </span>
      </span>

      <div className="flex items-center gap-x-2 shrink-0">
        {!paperIsOpen && <MenuFile fileName={fileName} />}
        {paperIsOpen && <MenuPaperFile fileName={fileName} individuallyArchived={individuallyArchived} archivedByFolder={archivedByFolder} needsRecoveryDestination={needsRecoveryDestination} />}
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
  individuallyArchived?: boolean;
  needsRecoveryDestination?: boolean;
}
