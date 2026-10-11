import ItemFile from "./ItemFile";
import NoFiles from "./NoFiles";
import NoMatches from "./NoMatches";
import usePreferences from "../hooks/usePreferences";
import useFile from "../hooks/useFile";
import { configStore } from "../store/configStore";
import { len, normalize, themes } from "../utils/helpers";
import { BASE_DIRECTORY } from "../utils/consts";
import { stat } from "@tauri-apps/plugin-fs";
import { memo, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { searchStore, type SortOptionId } from "../store/searchStore";
import { fileStore } from "../store/fileStore";
import type { Component } from "../utils/types";

const getHash = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
};

const ListFiles = memo(({ arr }: Props): Component => {
  const { myPaper } = usePreferences(),
    { isDay } = themes(),
    { getFilePath } = useFile(),
    { search, resetSearch, sortOption } = searchStore(
      useShallow(state => ({
        search: state.search,
        resetSearch: state.resetSearch,
        sortOption: (state.sortOption || state.sortOptions?.[0] || "mtime") as SortOptionId,
      }))
    ),
    paperIsOpen = configStore(state => state.paperIsOpen),
    fileIsEdited = fileStore(state => state.fileIsEdited),
    normalizedSearch = useMemo(() => normalize(search), [search]),
    paperFiles = useMemo(() => myPaper(arr), [arr, fileIsEdited]),
    paperSet = useMemo(() => new Set(paperFiles), [paperFiles]),
    [statsMap, setStatsMap] = useState<Record<string, { mtime: number; birthtime: number }>>({}),
    [statsLoaded, setStatsLoaded] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    if (!arr || arr.length === 0) {
      setStatsLoaded(true);
      return;
    }
    setStatsLoaded(false);

    Promise.all(
      arr.map(async name => {
        try {
          const { pathFile } = await getFilePath(name);
          const st = await stat(pathFile, BASE_DIRECTORY);
          const mtime = st.mtime ? new Date(st.mtime).getTime() : 0;
          const birthtime = st.birthtime ? new Date(st.birthtime).getTime() : mtime;
          return { name, mtime, birthtime };
        } catch {
          return { name, mtime: 0, birthtime: 0 };
        }
      })
    ).then(results => {
      if (!isMounted) return;
      const map: Record<string, { mtime: number; birthtime: number }> = {};
      results.forEach(item => {
        map[item.name] = { mtime: item.mtime, birthtime: item.birthtime };
      });
      setStatsMap(map);
      setStatsLoaded(true);
    });

    return () => {
      isMounted = false;
    };
  }, [arr, fileIsEdited]);

  const isStatsNeeded = sortOption === "mtime" || sortOption === "recent" || sortOption === "oldest";
  const isReady = !isStatsNeeded || statsLoaded;

  const files = useMemo(() => {
    const source = paperIsOpen ? paperFiles : arr.filter(f => !paperSet.has(f));

    const indexedSource = source.map(name => ({
      name,
      normalizedName: normalize(name),
    }));

    const filtered = source.filter((_, index) =>
      indexedSource[index].normalizedName.includes(normalizedSearch)
    );

    return filtered.sort((a, b) => {
      let res = 0;
      if (sortOption === "mtime") {
        res = (statsMap[b]?.mtime || 0) - (statsMap[a]?.mtime || 0);
      } else if (sortOption === "az") {
        res = a.localeCompare(b);
      } else if (sortOption === "za") {
        res = b.localeCompare(a);
      } else if (sortOption === "recent") {
        res = (statsMap[b]?.birthtime || 0) - (statsMap[a]?.birthtime || 0);
      } else if (sortOption === "oldest") {
        res = (statsMap[a]?.birthtime || 0) - (statsMap[b]?.birthtime || 0);
      } else if (sortOption === "random") {
        res = getHash(a) - getHash(b);
      }
      if (res !== 0) return res;
      return a.localeCompare(b);
    });
  }, [arr, normalizedSearch, sortOption, paperFiles, paperIsOpen, paperSet, statsMap]);

  useEffect(() => resetSearch(), [paperIsOpen]);

  function renderFiles(): Component {
    if (len(files) === 0) {
      if (len(normalizedSearch) > 0) return <NoMatches />;
      return <NoFiles />;
    }

    return (
      <>
        {files.map((n: string) => (
          <ItemFile fileName={n} key={n} />
        ))}
      </>
    );
  }

  return (
    <div className={`flex flex-col w-[680px] max-w-full transition-opacity duration-150 ${isReady ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
      {/* Cabecera DOCUMENTOS + Contador */}
      <div
        className={`flex items-center justify-between w-[680px] max-w-full px-1 pb-2.5 mb-1 border-b ${
          isDay ? "border-neutral-200 text-neutral-400" : "border-zinc-800/80 text-zinc-500"
        }`}
      >
        <span className="font-mono text-[11px] tracking-widest uppercase">
          {paperIsOpen ? "ARCHIVADOS" : "DOCUMENTOS"}
        </span>
        <span className="font-mono text-[11px] tracking-widest pr-1.5">
          {files.length}
        </span>
      </div>

      <ul className="flex flex-col w-[680px] max-w-full pb-20">
        {renderFiles()}
      </ul>
    </div>
  );
});

export default ListFiles;

interface Props {
  arr: string[];
}
