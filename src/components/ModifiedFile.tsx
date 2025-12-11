import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import translations from "../utils/dictionary";
import type { Component } from "../utils/types";

function ModifiedFile(): Component {
  const d = translations(),
    { getItem } = useStorage(),
    { selectedFile } = fileStore(),
    { myLastModified } = usePreferences(),
    { showHeader } = configStore(),
    lastModified: string = getItem(`${selectedFile.name}-modified`, "");

  return (
    <div className="flex items-center opacity-50 justify-end z-40 text-xs lowercase fixed bottom-8 right-4 sm:right-6 pointer-events-none">
      {myLastModified() && lastModified && showHeader && (
        <p className="whitespace-nowrap">
          {d.Modified}: {lastModified}
        </p>
      )}
    </div>
  );
}

export default ModifiedFile;
