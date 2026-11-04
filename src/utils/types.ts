import type { ChangeEvent, LazyExoticComponent, ReactNode } from "react";
import type { PathMatch } from "react-router-dom";
import type { StoreApi, UseBoundStore } from "zustand";

type Component = ReactNode | JSX.Element | JSX.Element[];

type LazyCmp = LazyExoticComponent<(arg0: Record<string, unknown>) => Component>;

type Match = PathMatch<string> | null;

type ZustandStore = UseBoundStore<StoreApi<object>>;

type SelectEvent = ChangeEvent<HTMLSelectElement>;

type Timer = ReturnType<typeof setTimeout>;

interface File {
  name: string;
  content: string;
  initialCaretPos?: number;
}

interface stylesText {
  fontSize: string;
  alignText: string;
  opacity: string;
  letterSpacing: string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    __lastTypingTime?: number;
    __lyraDebug?: unknown;
  }
}

export type {
  Timer,
  Component,
  File,
  Match,
  SelectEvent,
  stylesText,
  ZustandStore,
  LazyCmp,
};
