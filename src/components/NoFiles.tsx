import { twMerge } from "tailwind-merge";
import { configStore } from "../store/configStore.ts";
import translations from "../utils/dictionary.ts";
import { themes } from "../utils/helpers.ts";
import type { Component } from "../utils/types.ts";

function NoFiles(): Component {
  const { paperIsOpen } = configStore();
  const { isDay } = themes();
  const d = translations();

  return (
    <li
      className={twMerge(
        "w-full py-3.5 px-1 border-b text-left text-sm sm:text-[15px] select-none list-none",
        isDay ? "border-neutral-200/80 text-neutral-600" : "border-zinc-800/60 text-zinc-500"
      )}
    >
      {paperIsOpen ? d.NothingHere : d.AddYourFirstAnnotation}
    </li>
  );
}

export default NoFiles;
