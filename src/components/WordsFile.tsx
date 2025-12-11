import { twMerge } from "tailwind-merge";
import usePreferences from "../hooks/usePreferences";
import { configStore } from "../store/configStore";
import translations from "../utils/dictionary";
import type { Component } from "../utils/types";

function WordsFile({ wordCounts }: { wordCounts: number }): Component {
  const d = translations(),
    { showHeader } = configStore(),
    { myWordCount } = usePreferences(),
    showCount: boolean = showHeader && wordCounts != 0;

  return (
    <div
      className={twMerge(
        showCount ? "opacity-50" : "opacity-0",
        "flex items-center justify-end z-40 text-xs lowercase fixed bottom-4 right-4 sm:right-6 pointer-events-none"
      )}>
      {myWordCount() && <p>{wordCounts + " " + d.Words}</p>}
    </div>
  );
}

export default WordsFile;
