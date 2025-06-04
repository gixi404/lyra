import ItemFile from "./ItemFile";
import NoFiles from "./NoFiles";
import NoMatches from "./NoMatches";
import usePreferences from "../hooks/usePreferences";
import { animated, useSpring } from "@react-spring/web";
import { configStore } from "../store/configStore";
import { len, normalize } from "../utils/helpers";
import { memo, useEffect } from "react";
import { searchStore } from "../store/searchStore";
import type { Component } from "../utils/types";

const ListFiles = memo(({ arr }: Props): Component => {
  const { search, resetSearch, order } = searchStore(),
    { paperIsOpen } = configStore(),
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
    const { myPaper } = usePreferences(),
      allFiles = arr.filter((f: string) => !myPaper().includes(f)),
      files: string[] = paperIsOpen
        ? myPaper().filter(f => normalize(f).includes(normalize(search)))
        : allFiles.filter(f => normalize(f).includes(normalize(search)));

    if (len(files) == 0) {
      if (len(normalize(search)) > 0) return <NoMatches />;
      return <NoFiles />;
    }

    const sorted: string[] = files.sort((a, b) =>
      order ? a.localeCompare(b) : b.localeCompare(a)
    );

    return sorted.map((n: string) => <ItemFile fileName={n} key={n} />);
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
