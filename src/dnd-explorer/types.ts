export type DndItemKind = "file" | "folder";

export interface DragItem {
  kind: DndItemKind;
  id: string;       // "file:<path>" | "folder:<path>" | "folder:" (Lyra)
  path: string;     // "" for Lyra root
  isRoot: boolean;
}

export type DropTarget =
  | { type: "file-insert"; containerKey: string; index: number }
  | { type: "file-into-folder"; folderPath: string } // direct drop on folder -> end of direct notes
  | { type: "folder-into"; targetFolderPath: string } // hierarchical move: make child of target folder
  | { type: "folder-reorder"; parentKey: string; index: number; refPath?: string } // reorder among siblings
  | null;

export interface ContainerGeometry {
  containerKey: string;
  rect: DOMRect;
  /** visible item rects in order excluding dragged item */
  itemRects: Array<{ id: string; path: string; rect: DOMRect; midY: number }>;
}

export interface FolderRowGeometry {
  id: string;
  path: string;
  isRoot: boolean;
  rect: DOMRect;
  midY: number;
  parentKey: string;
}
