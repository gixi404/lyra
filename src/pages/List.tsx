import { useEffect } from "react";
import Form from "../components/Form";
import ListFiles from "../components/ListFiles";
import MainContainer from "../components/MainContainer";
import useFile from "../hooks/useFile";
import { fileStore } from "../store/fileStore";
import { verifyMainFolder } from "../utils/helpers";
import type { Component } from "../utils/types";
import { useShallow } from "zustand/react/shallow";

function List(): Component {
  const { getFilesWithStats } = useFile(),
    { setFilesWithStats, fileIsEdited, files } = fileStore(
      useShallow(state => ({
        setFilesWithStats: state.setFilesWithStats,
        fileIsEdited: state.fileIsEdited,
        files: state.files,
      }))
    );

  useEffect(() => {
    async function init() {
      await verifyMainFolder();
      const { files: filesList, stats } = await getFilesWithStats();
      setFilesWithStats(filesList, stats);
    }
    init();
  }, [fileIsEdited]);

  return (
    <MainContainer>
      <div className="flex flex-col items-center justify-start w-full min-h-screen pt-14 sm:pt-20 px-4 pb-12">
        <div className="w-[680px] max-w-full flex flex-col items-center gap-y-6 sm:gap-y-8">
          <Form />
          <ListFiles arr={files} />
        </div>
      </div>
    </MainContainer>
  );
}

export default List;
