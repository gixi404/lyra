import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import FolderExplorer from "../../src/components/FolderExplorer.tsx";
import { fileStore } from "../../src/store/fileStore.ts";
import { searchStore, type SortOptionId } from "../../src/store/searchStore.ts";
import { buildFileOrderFromPaths, registerFileOrderCapture } from "../../src/utils/manualOrder.ts";
import "../../src/styles.css";

const fixture = window as unknown as {
  fixtureSpec: { id: string; folders: string[]; sortOption?: SortOptionId };
  fixtureDisk: string[];
  fixtureRemoveFile: (path: string) => void;
};
fixture.fixtureRemoveFile = path => {
  fixture.fixtureDisk = fixture.fixtureDisk.filter(file => file !== path);
  sessionStorage.setItem(`fixtureDisk:${fixture.fixtureSpec.id}`, JSON.stringify(fixture.fixtureDisk));
  fileStore.setState({ files: fixture.fixtureDisk });
};
fileStore.setState({ files: fixture.fixtureDisk, folders: fixture.fixtureSpec.folders,
  statsMap: {}, archivedFolders: [], listingGeneration: 1, fileIsEdited: false,
  selectedFile: { name: "", content: "" } });
searchStore.setState({ sortOption: fixture.fixtureSpec.sortOption || "manual" });
registerFileOrderCapture(() => buildFileOrderFromPaths(fileStore.getState().files));

function Fixture() {
  const files = fileStore(state => state.files);
  const sortOption = searchStore(state => state.sortOption);
  return <MemoryRouter><div style={{ height: 550, overflow: "auto" }} data-explorer-scroll data-fixture-sort-option={sortOption}>
    <div style={{ width: "min(680px, 100%)", marginInline: "auto" }}>
    <FolderExplorer folders={fixture.fixtureSpec.folders} files={files} manualOrder={sortOption === "manual"} renderFile={(path, depth) => (
      <div data-fixture-file={path} style={{ padding: 14, paddingLeft: depth * 20, borderBottom: "1px solid #555" }}>{path}</div>
    )} />
    </div>
  </div></MemoryRouter>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
