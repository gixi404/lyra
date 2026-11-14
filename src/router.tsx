import { createBrowserRouter } from "react-router-dom";
import { lazy } from "react";
import { PAGES } from "./utils/consts.ts";
import ListPage from "./pages/List.tsx";
import type { LazyCmp } from "./utils/types.ts";
import { registerNavigator, navigateTo } from "./utils/navigation.ts";
import { DND_PROTOTYPE_ROUTE_ENABLED } from "./dnd-explorer/config.ts";
import { scrollDebug, snapshotScrollState } from "./utils/scrollDebug.ts";

const FilePage: LazyCmp = lazy(() => import("./pages/FileContent"));
const PreferencesPage: LazyCmp = lazy(() => import("./pages/Preferences"));
const DndPrototypePage: LazyCmp = lazy(() => import("./pages/DndPrototype"));

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
    ...(DND_PROTOTYPE_ROUTE_ENABLED
      ? [{ path: "/__dnd-prototype", element: <DndPrototypePage /> }]
      : []),
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);

router.subscribe((state) => {
  try {
    scrollDebug("router.subscribe", {
      location: state.location?.pathname,
      navigationState: state.navigation?.state,
      navigationLocation: state.navigation?.location?.pathname ?? null,
      historyAction: state.historyAction,
    });
    snapshotScrollState("router.subscribe", { location: state.location?.pathname });
  } catch {}
});

registerNavigator((path: string) => {
  void router.navigate(path);
});

export { navigateTo };
