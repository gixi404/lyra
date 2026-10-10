import ItemFile from "./ItemFile";
import NoFiles from "./NoFiles";
import NoMatches from "./NoMatches";
import usePreferences from "../hooks/usePreferences";
import { configStore } from "../store/configStore";
import { len, normalize, themes } from "../utils/helpers";
import { memo, useEffect, useMemo } from "react";
import { shallow } from "zustand/shallow";
import { searchStore } from "../store/searchStore";
import { fileStore } from "../store/fileStore";
import type { Component } from "../utils/types";

const ListFiles = memo(({ arr }: Props): Component => {
  const { myPaper } = usePreferences(),
    { isDay } = themes(),
    { search, resetSearch, order } = searchStore(
      state => ({
        search: state.search,
        resetSearch: state.resetSearch,
        order: state.order,
      }),
      shallow
    ),
    paperIsOpen = configStore(state => state.paperIsOpen),
    fileIsEdited = fileStore(state => state.fileIsEdited),
    normalizedSearch = useMemo(() => normalize(search), [search]),
    paperFiles = useMemo(() => myPaper(arr), [arr, fileIsEdited]),
    paperSet = useMemo(() => new Set(paperFiles), [paperFiles]),
    files = useMemo(() => {
      const source = paperIsOpen ? paperFiles : arr.filter(f => !paperSet.has(f));

      const indexedSource = source.map(name => ({
        name,
        normalizedName: normalize(name),
      }));

      return source
        .filter((_, index) => indexedSource[index].normalizedName.includes(normalizedSearch))
        .sort((a, b) => (order ? a.localeCompare(b) : b.localeCompare(a)));
    }, [arr, normalizedSearch, order, paperFiles, paperIsOpen, paperSet]);

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
    <div className="flex flex-col w-[680px] max-w-full">
      {/* Cabecera DOCUMENTOS + Contador */}
      <div
        className={`flex items-center justify-between w-[680px] max-w-full pb-2.5 mb-1 border-b ${
          isDay ? "border-neutral-200 text-neutral-400" : "border-zinc-800/80 text-zinc-500"
        }`}
      >
        <span className="font-mono text-[11px] tracking-widest uppercase">
          {paperIsOpen ? "PAPELERA" : "DOCUMENTOS"}
        </span>
        <span className="font-mono text-[11px] tracking-widest">
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
