import { invoke } from "@tauri-apps/api";
import { documentDir, join } from "@tauri-apps/api/path";
import { Folder } from "lucide-react";
import MainContainer from "../components/MainContainer";
import { MAIN_FOLDER } from "../utils/consts";
import translations from "../utils/dictionary";
import type { Component } from "../utils/types";

function MyFiles(): Component {
  const d = translations();

  async function openFolder(): Promise<void> {
    try {
      const docPath: string = await documentDir();
      const path: string = await join(docPath, MAIN_FOLDER);
      await invoke("open_folder", { path });
    } catch (err: any) {
      console.error(`catch 'openFolder' ${err.message}`);
    }
  }

  return (
    <MainContainer>
      <p className="text-lg sm:text-xl w-full text-center mt-14">
        {d.YourFilesAreLocatedIn}
      </p>
      <button
        onClick={openFolder}
        className="bg-indigo-600 hover:bg-indigo-500 duration-100 px-6 py-2 text-xl sm:text-2xl font-medium font-serif rounded-lg border border-indigo-400 flex justify-center items-center gap-x-4">
        <Folder size={24} color="white" />
        <span>{d.OpenFolder}</span>
      </button>
    </MainContainer>
  );
}

export default MyFiles;
