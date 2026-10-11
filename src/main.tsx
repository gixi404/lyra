import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { lazy, StrictMode, Suspense } from "react";
import { PAGES } from "./utils/consts";
import Toast from "./components/Toast";
import "./styles.css";
import ListPage from "./pages/List";
import { type Container, createRoot } from "react-dom/client";
import type { LazyCmp } from "./utils/types";

const root = document.getElementById("root") as Container,
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

try {
  const savedTheme = window.localStorage.getItem("theme");
  const isDark =
    savedTheme === "clear-nigth" ||
    savedTheme === "dark-nigth" ||
    (savedTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const initialBg = isDark ? "#101010" : "#e0e0e0";
  document.documentElement.style.backgroundColor = initialBg;
  document.body.style.backgroundColor = initialBg;
  if (isDark) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
} catch {}

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<div className="w-full min-h-screen bg-[#e0e0e0] dark:bg-[#101010]" />}>
      <RouterProvider router={router} />
    </Suspense>
    <Toast />
  </StrictMode>
);
