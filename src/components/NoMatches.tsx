import { twMerge } from "tailwind-merge";
import translations from "../utils/dictionary";
import { themes } from "../utils/helpers";
import type { Component } from "../utils/types";

function NoMatches(): Component {
  const d = translations();
  const { isDay } = themes();

  return (
    <li
      className={twMerge(
        "w-full py-3.5 px-1 border-b text-left font-sans text-sm sm:text-[15px] select-none list-none",
        isDay ? "border-neutral-200/80 text-neutral-500" : "border-zinc-800/60 text-zinc-500"
      )}
    >
      {d.NothingHere}
    </li>
  );
}

export default NoMatches;
