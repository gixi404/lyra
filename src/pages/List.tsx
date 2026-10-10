import { useEffect, useState } from "react";
import Form from "../components/Form";
import ListFiles from "../components/ListFiles";
import Loading from "../components/Loading";
import MainContainer from "../components/MainContainer";
import useFile from "../hooks/useFile";
import { fileStore } from "../store/fileStore";
import { verifyMainFolder, verifySystemLang } from "../utils/helpers";
import type { Component } from "../utils/types";
import { shallow } from "zustand/shallow";

function List(): Component {
  const { getFiles } = useFile(),
    { setFiles, fileIsEdited, files } = fileStore(
      state => ({
        setFiles: state.setFiles,
        fileIsEdited: state.fileIsEdited,
        files: state.files,
      }),
      shallow
    ),
    [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    async function init() {
      await verifyMainFolder();
      await verifySystemLang();
      const filesList = await getFiles();
      setFiles(filesList);
      setLoading(false);
    }
    init();
  }, [fileIsEdited]);

  return (
    <MainContainer>
      <div className="flex flex-col items-center justify-start w-full min-h-screen pt-14 sm:pt-20 px-4 pb-12">
        <div className="w-[680px] max-w-full flex flex-col items-center gap-y-6 sm:gap-y-8">
          <Form />
          {loading ? <Loading /> : <ListFiles arr={files} />}
        </div>
      </div>
    </MainContainer>
  );
}

export default List;
