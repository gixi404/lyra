import { createBrowserRouter } from "react-router-dom";
import { lazy } from "react";
import { PAGES } from "./utils/consts";
import ListPage from "./pages/List";
import type { LazyCmp } from "./utils/types";

const FilePage: LazyCmp = lazy(() => import("./pages/FileContent"));
const PreferencesPage: LazyCmp = lazy(() => import("./pages/Preferences"));

export const router = createBrowserRouter([
  {
    path: PAGES.list,
    element: <ListPage />,
  },
  {
    path: PAGES.file,
    element: <FilePage />,
  },
  {
    path: PAGES.preferences,
    element: <PreferencesPage />,
  },
]);

export function navigateTo(path: string): void {
  if (typeof document !== "undefined" && "startViewTransition" in document) {
    (document as any).startViewTransition(() => {
      void router.navigate(path);
    });
  } else {
    void router.navigate(path);
  }
}
