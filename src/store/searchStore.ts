import { create } from "zustand";
import { scheduleSavePersistentPreferences } from "../utils/persistentPreferences.ts";
import { applyListScroll, resetListScroll } from "../utils/listScroll.ts";
import { configStore } from "./configStore.ts";
import {
  captureCurrentFileOrder,
  mergeCapturedFileOrder,
  readStoredFileOrder,
  writeStoredFileOrder,
} from "../utils/manualOrder.ts";
import type { FolderOrder } from "../utils/folderTree.ts";

function resetContainerScroll(): void {
  // El scroll real del listado es el de la ventana; applyListScroll lo
  // resuelve (contenedor scrollable o ventana) en un único punto.
  try {
    applyListScroll(0);
  } catch {}
}

export const SORT_OPTION_IDS = ["mtime", "az", "za", "recent", "oldest", "random", "manual"] as const;

export type SortOptionId = (typeof SORT_OPTION_IDS)[number];

/** Resuelve una preferencia guardada sin inventar un orden distinto de "Última edición". */
export function resolveSortOption(raw: string | null | undefined): SortOptionId {
  return raw && (SORT_OPTION_IDS as readonly string[]).includes(raw)
    ? (raw as SortOptionId)
    : "mtime";
}

const getInitialSortOption = (): SortOptionId => {
  try {
    return resolveSortOption(localStorage.getItem("sortOption"));
  } catch {
    return "mtime";
  }
};

const initialSort = getInitialSortOption();

export interface SetSortOptionOptions {
  /** Orden visual ya capturado. Si falta, se consulta la fuente registrada por el explorador. */
  fileOrder?: FolderOrder;
}

type SearchStoreSet = {
  (partial: Partial<SearchStoreState> | ((state: SearchStoreState) => Partial<SearchStoreState>)): void;
};
type SearchStoreGet = () => SearchStoreState;

export interface SearchStoreState {
  search: string;
  setSearch: (search: string) => void;
  resetSearch: () => void;
  order: boolean;
  toggleOrder: (newOrder: boolean) => void;
  sortOption: SortOptionId;
  sortOptions: SortOptionId[];
  setSortOption: (id: SortOptionId, options?: SetSortOptionOptions) => void;
  toggleSortOption: (id: SortOptionId, options?: SetSortOptionOptions) => void;
}


function applySortOption(
  set: SearchStoreSet,
  get: SearchStoreGet,
  id: SortOptionId,
  options?: SetSortOptionOptions,
): void {
  const previous = get().sortOption;

  // "Manual" nunca reordena por sí mismo: adopta el orden que ya se está viendo.
  if (id === "manual" && previous !== "manual") {
    const captured = options?.fileOrder ?? captureCurrentFileOrder();
    if (captured) {
      const nextOrder = mergeCapturedFileOrder(readStoredFileOrder(), captured);
      writeStoredFileOrder(nextOrder);
      configStore.getState().bumpPrefTick();
    }
  }

  try {
    localStorage.setItem("sortOption", id);
    scheduleSavePersistentPreferences();
  } catch {}

  // Cambiar a Manual no debe desplazar la vista ni interrumpir un arrastre.
  if (id !== "manual") {
    resetListScroll();
    resetContainerScroll();
  }

  set({
    sortOption: id,
    sortOptions: [id],
    order: id !== "za",
  });
}

export const searchStore = create<SearchStoreState>((set, get) => ({
  search: "",
  setSearch: (search: string) => {
    if (search.trim().length > 0) {
      // Una nueva consulta comienza arriba. Se reinicia también la intención
      // guardada para que al volver del editor no se restaure un scroll ajeno
      // a los resultados filtrados.
      resetListScroll();
      resetContainerScroll();
    }
    set({ search });
  },
  resetSearch: () => set({ search: "" }),
  order: initialSort !== "za",
  toggleOrder: (newOrder: boolean) => set({ order: newOrder }),
  sortOption: initialSort,
  sortOptions: [initialSort],
  setSortOption: (id: SortOptionId, options?: SetSortOptionOptions) => {
    applySortOption(set, get, id, options);
  },
  toggleSortOption: (id: SortOptionId, options?: SetSortOptionOptions) => {
    applySortOption(set, get, id, options);
  },
}));

export function hydrateSortOptionFromStorage(): void {
  const sortOption = getInitialSortOption();
  const current = searchStore.getState();
  if (current.sortOption === sortOption) return;
  searchStore.setState({ sortOption, sortOptions: [sortOption], order: sortOption !== "za" });
}
