import { create } from "zustand";
import { scheduleSavePersistentPreferences } from "../utils/persistentPreferences.ts";
import { applyListScroll, resetListScroll } from "../utils/listScroll.ts";

function resetContainerScroll(): void {
  // El scroll real del listado es el de la ventana; applyListScroll lo
  // resuelve (contenedor scrollable o ventana) en un único punto.
  try {
    applyListScroll(0);
  } catch {}
}

export type SortOptionId = "mtime" | "az" | "za" | "recent" | "oldest" | "random";

const getInitialSortOption = (): SortOptionId => {
  try {
    const saved = localStorage.getItem("sortOption");
    if (saved && ["mtime", "az", "za", "recent", "oldest", "random"].includes(saved)) {
      return saved as SortOptionId;
    }
  } catch {}
  return "mtime";
};

const initialSort = getInitialSortOption();

export interface SearchStoreState {
  search: string;
  setSearch: (search: string) => void;
  resetSearch: () => void;
  order: boolean;
  toggleOrder: (newOrder: boolean) => void;
  sortOption: SortOptionId;
  sortOptions: SortOptionId[];
  setSortOption: (id: SortOptionId) => void;
  toggleSortOption: (id: SortOptionId) => void;
}

export const searchStore = create<SearchStoreState>(set => ({
  search: "",
  setSearch: (search: string) => {
    if (search.trim().length > 0) {
      resetContainerScroll();
    }
    set({ search });
  },
  resetSearch: () => set({ search: "" }),
  order: initialSort !== "za",
  toggleOrder: (newOrder: boolean) => set({ order: newOrder }),
  sortOption: initialSort,
  sortOptions: [initialSort],
  setSortOption: (id: SortOptionId) => {
    try {
      localStorage.setItem("sortOption", id);
      scheduleSavePersistentPreferences();
    } catch {}
    resetListScroll();
    resetContainerScroll();
    set({
      sortOption: id,
      sortOptions: [id],
      order: id !== "za",
    });
  },
  toggleSortOption: (id: SortOptionId) => {
    try {
      localStorage.setItem("sortOption", id);
      scheduleSavePersistentPreferences();
    } catch {}
    resetListScroll();
    resetContainerScroll();
    set({
      sortOption: id,
      sortOptions: [id],
      order: id !== "za",
    });
  },
}));
