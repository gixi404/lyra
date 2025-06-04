import { create } from "zustand";
import type { ZustandStore } from "../utils/types";

export const configStore: ZustandStore = create((set: any) => ({
  paperIsOpen: false,
  setPaperIsOpen: () =>
    set((state: any) => ({ paperIsOpen: !state.paperIsOpen })),
  spellCheck: false,
  setSpellCheck: (newState: boolean) => set(() => ({ spellCheck: newState })),
  showHeader: true,
  setShowHeader: (newState: boolean) => set(() => ({ showHeader: newState })),
}));
