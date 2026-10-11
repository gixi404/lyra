import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { lazy, StrictMode, Suspense } from "react";
import { PAGES } from "./utils/consts";
import Toast from "./components/Toast";
import "./styles.css";
import { type Container, createRoot } from "react-dom/client";
import type { LazyCmp } from "./utils/types";

const root = document.getElementById("root") as Container,
  ListPage: LazyCmp = lazy(() => import("./pages/List")),
  FilePage: LazyCmp = lazy(() => import("./pages/FileContent")),
  PreferencesPage: LazyCmp = lazy(() => import("./pages/Preferences")),
  router = createBrowserRouter([
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

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<></>}>
      <RouterProvider router={router} />
    </Suspense>
    <Toast />
  </StrictMode>
);
