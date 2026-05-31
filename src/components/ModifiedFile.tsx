import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { configStore } from "../store/configStore";
import { fileStore } from "../store/fileStore";
import translations from "../utils/dictionary";
import { getCompatibleStorageKeys } from "../utils/helpers";
import type { Component } from "../utils/types";

function ModifiedFile(): Component {
  const d = translations(),
    { getItem } = useStorage(),
    { selectedFile } = fileStore(),
    { myLastModified } = usePreferences(),
    { showHeader } = configStore(),
    modifiedKeys: string[] = getCompatibleStorageKeys(selectedFile.name, "-modified"),
    lastModified: string = modifiedKeys.reduce(
      (value: string, key: string) => (value ? value : getItem(key, "")),
      ""
    );

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
