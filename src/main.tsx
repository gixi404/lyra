import { lazy, StrictMode, Suspense } from "react";
import { type Container, createRoot } from "react-dom/client";
import { Toaster } from "react-hot-toast";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import usePreferences from "./hooks/usePreferences";
import PresentationPage from "./pages/Presentation";
import "./styles.css";
import { PAGES } from "./utils/consts";
import type { LazyCmp } from "./utils/types";

const root = document.getElementById("root") as Container,
  ListPage: LazyCmp = lazy(() => import("./pages/List")),
  FilePage: LazyCmp = lazy(() => import("./pages/FileContent")),
  PreferencesPage: LazyCmp = lazy(() => import("./pages/Preferences")),
  SupportPage: LazyCmp = lazy(() => import("./pages/Support")),
  MyFilesPage: LazyCmp = lazy(() => import("./pages/MyFiles")),
  { myFontValue } = usePreferences(),
  router = createBrowserRouter([
    {
      path: PAGES.presentation,
      element: <PresentationPage />,
    },
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
    {
      path: PAGES.support,
      element: <SupportPage />,
    },
    {
      path: PAGES.myFiles,
      element: <MyFilesPage />,
    },
  ]);

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={null}>
      <RouterProvider router={router} />
    </Suspense>
    <Toaster
      position="top-right"
      reverseOrder={false}
      containerClassName={myFontValue()}
    />
  </StrictMode>
);
