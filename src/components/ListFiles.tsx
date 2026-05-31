import ItemFile from "./ItemFile";
import NoFiles from "./NoFiles";
import NoMatches from "./NoMatches";
import usePreferences from "../hooks/usePreferences";
import { animated, useSpring } from "@react-spring/web";
import { configStore } from "../store/configStore";
import { len, normalize } from "../utils/helpers";
import { memo, useEffect, useMemo } from "react";
import { shallow } from "zustand/shallow";
import { searchStore } from "../store/searchStore";
import { fileStore } from "../store/fileStore";
import type { Component } from "../utils/types";

const ListFiles = memo(({ arr }: Props): Component => {
  const { myPaper } = usePreferences(),
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
    paperFiles = useMemo(() => myPaper(), [fileIsEdited]),
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
    }, [arr, normalizedSearch, order, paperFiles, paperIsOpen, paperSet]),
    animation = {
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 200 },
    },
    [styles, api] = useSpring(() => ({ opacity: 1 }));

  useEffect(() => resetSearch(), [paperIsOpen]);

  useEffect(() => {
    api.start(animation);
  }, [search, paperIsOpen]);

  function renderFiles(): Component {
    if (len(files) == 0) {
      if (len(normalizedSearch) > 0) return <NoMatches />;
      return <NoFiles />;
    }

    return files.map((n: string) => <ItemFile fileName={n} key={n} />);
  }

  return (
    <animated.ol
      style={styles}
      className="grid grid-cols-1 gap-y-2 place-items-center w-full overflow-hidden pb-20"
    >
      {renderFiles()}
    </animated.ol>
  );
});

export default ListFiles;

interface Props {
  arr: string[];
}
