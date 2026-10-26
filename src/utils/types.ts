import type { ChangeEvent, LazyExoticComponent, ReactNode } from "react";
import type { PathMatch } from "react-router-dom";
import type { StoreApi, UseBoundStore } from "zustand";

type Component = ReactNode | JSX.Element | JSX.Element[];

type LazyCmp = LazyExoticComponent<(arg0: any) => Component>;

type Match = PathMatch<string> | null;

type ZustandStore = UseBoundStore<StoreApi<any>>;

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
