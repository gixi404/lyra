import { createBrowserRouter } from "react-router-dom";
import { lazy } from "react";
import { PAGES } from "./utils/consts.ts";
import ListPage from "./pages/List.tsx";
import type { LazyCmp } from "./utils/types.ts";
import { registerNavigator, navigateTo } from "./utils/navigation.ts";

const FilePage: LazyCmp = lazy(() => import("./pages/FileContent"));
const PreferencesPage: LazyCmp = lazy(() => import("./pages/Preferences"));

export const router = createBrowserRouter(
  [
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
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);

registerNavigator((path: string) => {
  void router.navigate(path);
});

export { navigateTo };
