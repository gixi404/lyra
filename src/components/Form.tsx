import translations from "../utils/dictionary";
import useFile from "../hooks/useFile";
import { animated, useSpring } from "@react-spring/web";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import { PAGES } from "../utils/consts";
import { searchStore } from "../store/searchStore";
import { twMerge } from "tailwind-merge";
import {
  Plus as AddIcon,
  ArrowDownAz,
  ArrowDownZa,
  Archive as PaperIcon,
} from "lucide-react";
import {
  type FormEvent,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
import Dialog, { type SweetAlertResult } from "sweetalert2";
import {
  nameIsValid,
  navigation,
  notification,
  sanitizeFileName,
  themes,
} from "../utils/helpers";
import type { Component, File } from "../utils/types";

function Form(): Component {
  const d = translations(),
    { goTo } = navigation(),
    { isDay } = themes(),
    { createFile } = useFile(),
    { paperIsOpen, setPaperIsOpen } = configStore(),
    [fileName, setFileName] = useState<string>(""),
    { search, setSearch, order, toggleOrder } = searchStore(),
    { updateListFiles, setSelectedFile, files } = fileStore(),
    isRepeated = (fileName: string): boolean =>
      files.some((name: string) => name == fileName),
    animation = {
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 150 },
    },
    [stylesToggle, apiToggle] = useSpring(() => animation),
    [add, setAdd] = useState<boolean>(true),
    [stylesAdd, apiAdd] = useSpring(() => animation),
    [stylesPaper, apiPaper] = useSpring(() => animation);

  useEffect(() => {
    apiToggle.start(animation);
  }, [order]);

  useEffect(() => {
    apiPaper.start(animation);
  }, [paperIsOpen]);

  useEffect(() => {
    apiAdd.start(animation);
  }, [add]);

  function addFile(e: SyntheticEvent): void {
    e.stopPropagation();
    setAdd(!add);
    Dialog.fire({
      title: d.EnterTheFileName,
      input: "text",
      showCancelButton: true,
      inputAttributes: { autoComplete: "off" },
      inputAutoFocus: true,
      confirmButtonColor: "#1d74c5",
      cancelButtonColor: "#565454",
      confirmButtonText: d.Add,
      cancelButtonText: d.Cancel,
      background: isDay ? "#dedede" : "#202020",
      color: isDay ? "#000" : "#fff",
      customClass: { input: "no-focus-outline" },
    }).then((res: SweetAlertResult) => {
      if (res.isConfirmed) {
        e.preventDefault();
        const sanitizedName: string = sanitizeFileName(res.value);
        const file: File = {
          name: sanitizedName,
          content: `## ${sanitizedName} ${empty_text}`,
        };
        validateFields(file);
      }
    });
  }

  function fileManagement(file: File): void {
    setFileName("");
    createFile(file.name);
    updateListFiles(file.name);
    setSelectedFile(file);
    goTo(PAGES.file);
  }

  function validateFields(file: File): void {
    switch (true) {
      case paperIsOpen:
        break;

      case isRepeated(file.name):
        notification("error", d.RepeatedItem);
        break;

      case !file.name:
        notification("error", d.EnterName);
        break;

      case !nameIsValid(file.name):
        break;

      default:
        fileManagement(file);
        break;
    }
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (fileName) addFile(e);
    else return;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col justify-center items-center w-full text-slate-400 gap-y-4 sm:gap-y-6 max-w-[340px] opacity-80 px-4 sm:px-0"
    >
      <div className="flex justify-end items-start gap-x-2 sm:gap-x-3 w-full">
        <input
          autoFocus
          type="search"
          className={twMerge(
            isDay
              ? "placeholder:text-gray-600 bg-white text-gray-900 border-gray-400 shadow-sm"
              : "placeholder:text-sky-200/60 border-sky-400 bg-gray-800 text-sky-100",
            "w-full border h-[38px] sm:h-[42px] rounded-md px-3 sm:px-4 outline-0 text-sm sm:text-base"
          )}
          placeholder={d.Search + "..."}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <animated.button
          style={stylesAdd}
          onClick={addFile}
          className={twMerge(
            isDay
              ? "bg-white hover:bg-gray-50 text-gray-700 border border-gray-400 shadow-sm"
              : "bg-gray-800 hover:bg-gray-700 text-sky-400 border border-sky-400",
            "flex items-center justify-center gap-x-3 px-2 sm:px-3 h-[38px] sm:h-[42px] rounded-md transition-colors"
          )}
        >
          <AddIcon size={20} className="sm:w-[25px] sm:h-[25px]" strokeWidth={2.5} />
        </animated.button>
        <animated.button
          style={stylesToggle}
          onClick={() => toggleOrder(!order)}
          className={twMerge(
            isDay
              ? "bg-white hover:bg-gray-50 text-gray-700 border border-gray-400 shadow-sm"
              : "bg-gray-800 hover:bg-gray-700 text-sky-400 border border-sky-400",
            "flex items-center justify-center gap-x-3 px-2 sm:px-3 h-[38px] sm:h-[42px] rounded-md transition-colors"
          )}
        >
          {order ? (
            <ArrowDownAz size={20} className="sm:w-[25px] sm:h-[25px]" strokeWidth={2} />
          ) : (
            <ArrowDownZa size={20} className="sm:w-[25px] sm:h-[25px]" strokeWidth={2} />
          )}
        </animated.button>
        <animated.button
          style={stylesPaper}
          onClick={setPaperIsOpen}
          className={twMerge(
            isDay
              ? "bg-white hover:bg-gray-50 text-gray-700 border border-gray-400 shadow-sm"
              : "bg-gray-800 hover:bg-gray-700 text-sky-400 border border-sky-400",
            paperIsOpen && isDay && "bg-indigo-100 border-indigo-500",
            paperIsOpen && !isDay && "bg-blue-950",
            "flex items-center justify-center gap-x-3 border h-[38px] sm:h-[42px] rounded-md transition-colors px-2 sm:px-3"
          )}
        >
          <PaperIcon size={18} className="sm:w-[20px] sm:h-[20px]" strokeWidth={2} />
        </animated.button>
      </div>
      {paperIsOpen && (
        <p
          className={twMerge(
            isDay ? "text-slate-900" : "text-slate-300",
            "w-full text-base sm:text-lg text-center"
          )}
        >
          {d.Archived}
        </p>
      )}
    </form>
  );
}

export default Form;

const empty_text: string = `
  
  
  
  
  
  
  












  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  











`;
