import { create } from "zustand";
import type { ZustandStore } from "../utils/types";

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

export const searchStore: ZustandStore = create((set: any) => ({
  search: "",
  setSearch: (search: string) => set({ search }),
  resetSearch: () => set({ search: "" }),
  order: initialSort !== "za",
  toggleOrder: (newOrder: boolean) => set({ order: newOrder }),
  sortOption: initialSort,
  sortOptions: [initialSort],
  setSortOption: (id: SortOptionId) => {
    try {
      localStorage.setItem("sortOption", id);
    } catch {}
    set({
      sortOption: id,
      sortOptions: [id],
      order: id !== "za",
    });
  },
  toggleSortOption: (id: SortOptionId) => {
    try {
      localStorage.setItem("sortOption", id);
    } catch {}
    set({
      sortOption: id,
      sortOptions: [id],
      order: id !== "za",
    });
  },
}));
