import { useEffect, useState } from "react";
import Form from "../components/Form";
import ListFiles from "../components/ListFiles";
import Loading from "../components/Loading";
import MainContainer from "../components/MainContainer";
import useFile from "../hooks/useFile";
import { fileStore } from "../store/fileStore";
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
    getFiles()
      .then(files => setFiles(files))
      .finally(() => setLoading(false));
  }, [fileIsEdited]);

  return (
    <MainContainer>
      <div className="flex flex-row justify-center items-start w-full h-full">
        <div className="w-full max-w-[960px] h-5/6 overflow-x-hidden overflow-y-visible flex flex-col justify-center items-center gap-y-8 px-4">
          <Form />
          {loading ? <Loading /> : <ListFiles arr={files} />}
        </div>
      </div>
    </MainContainer>
  );
}

export default List;
