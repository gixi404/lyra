import PresentationPage from "./pages/Presentation";
import usePreferences from "./hooks/usePreferences";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { lazy, StrictMode, Suspense } from "react";
import { PAGES } from "./utils/consts";
import { Toaster } from "react-hot-toast";
import "./styles.css";
import { type Container, createRoot } from "react-dom/client";
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
    <Suspense fallback={<></>}>
      <RouterProvider router={router} />
    </Suspense>
    <Toaster
      position="top-right"
      reverseOrder={false}
      containerClassName={myFontValue()}
    />
  </StrictMode>
);
