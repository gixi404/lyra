import { create } from "zustand";

export interface ConfigState {
  paperIsOpen: boolean;
  setPaperIsOpen: (isOpen?: boolean) => void;
  spellCheck: boolean;
  setSpellCheck: (newState: boolean) => void;
  showHeader: boolean;
  setShowHeader: (newState: boolean) => void;
  themeTick: number;
  toggleThemeTick: () => void;
  prefTick: number;
  bumpPrefTick: () => void;
}

export const configStore = create<ConfigState>(set => ({
  paperIsOpen: false,
  setPaperIsOpen: (isOpen?: boolean) =>
    set(state => ({ paperIsOpen: typeof isOpen === "boolean" ? isOpen : !state.paperIsOpen })),
  spellCheck: false,
  setSpellCheck: (newState: boolean) => set(() => ({ spellCheck: newState })),
  showHeader: true,
  setShowHeader: (newState: boolean) => set(() => ({ showHeader: newState })),
  themeTick: 0,
  toggleThemeTick: () =>
    set(state => ({ themeTick: state.themeTick + 1 })),
  prefTick: 0,
  bumpPrefTick: () =>
    set(state => ({ prefTick: state.prefTick + 1 })),
}));
