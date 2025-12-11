import { animated, useSpring } from "@react-spring/web";
import { ArrowUpLeft as RecoveryIcon, Trash as RemoveIcon } from "lucide-react";
import type { SyntheticEvent } from "react";
import Dialog from "sweetalert2";
import { twMerge } from "tailwind-merge";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { fileStore } from "../store/fileStore";
import translations from "../utils/dictionary";
import { notification, themes } from "../utils/helpers";
import type { Component } from "../utils/types";

function MenuPaperFile({ fileName }: Props): Component {
  const d = translations(),
    { isDay } = themes(),
    { setItem } = useStorage(),
    { myPaper } = usePreferences(),
    { deleteFile } = useFile(),
    { editedFile, removeFileFromList } = fileStore(),
    [styles] = useSpring(() => ({
      from: { opacity: 0 },
      to: { opacity: 1 },
      config: { duration: 100 },
    }));

  function recoveryPaperItem(e: SyntheticEvent): void {
    e.stopPropagation();
    Dialog.fire({
      text: d.RestoreQuestion,
      icon: "question",
      showCancelButton: true,
      confirmButtonColor: "#1d74c5",
      cancelButtonColor: "#565454",
      confirmButtonText: d.Recover,
      cancelButtonText: d.Cancel,
      background: isDay ? "#dedede" : "#202020",
      color: isDay ? "#000" : "#fff",
    }).then(res => {
      if (res.isConfirmed) {
        const updatedPaper: string[] = myPaper().filter(
          (f: string) => f != fileName
        );
        setItem("paper", JSON.stringify(updatedPaper));
        notification("success", d.FileRecovered);
        editedFile();
      }
    });
  }

  function removeItem(e: SyntheticEvent): void {
    e.stopPropagation();

    Dialog.fire({
      text: d.DeleteQuestion,
      icon: "warning",
      showCancelButton: true,
      confirmButtonColor: "#d33",
      confirmButtonText: d.Delete,
      cancelButtonText: d.Cancel,
      background: isDay ? "#dedede" : "#202020",
      color: isDay ? "#000" : "#fff",
    }).then(res => {
      if (res.isConfirmed) {
        const updatedPaper: string[] = myPaper().filter(
          (f: string) => f != fileName
        );
        removeFileFromList(fileName);
        setItem("paper", JSON.stringify(updatedPaper));
        deleteFile(fileName);
        editedFile();
        notification("success", d.DeletedFile);
      }
    });
  }
  return (
    <animated.div
      style={styles}
      className="flex w-20 justify-center items-center gap-x-1 h-full absolute top-0 right-0 duration-200">
      <RecoveryIcon
        onClick={recoveryPaperItem}
        size={23}
        className={twMerge(
          isDay
            ? "hover:text-green-700 text-gray-600"
            : "text-[#6cd3ff] hover:text-[#c3edff]",
          " h-full w-8 py-3"
        )}
      />
      <RemoveIcon
        onClick={removeItem}
        size={20}
        className={twMerge(
          isDay
            ? "hover:text-red-700 text-gray-600"
            : "text-[#6cd3ff] hover:text-[#c3edff]",
          " h-full w-8 py-3"
        )}
      />
    </animated.div>
  );
}

export default MenuPaperFile;

interface Props {
  fileName: string;
}
