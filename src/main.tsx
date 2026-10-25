import { RouterProvider } from "react-router-dom";
import { StrictMode, Suspense } from "react";
import Toast from "./components/Toast";
import "./styles.css";
import { type Container, createRoot } from "react-dom/client";
import { checkAndApplyUpdate } from "./utils/updater";
import { router } from "./router";

const root = document.getElementById("root") as Container;

try {
  const savedTheme = window.localStorage.getItem("theme");
  const isLight =
    savedTheme === "sunny-day" ||
    savedTheme === "Day" ||
    (savedTheme === "auto" && !window.matchMedia("(prefers-color-scheme: dark)").matches);
  const isDark = !isLight;
  const initialBg = isDark ? "#101010" : "#e0e0e0";
  document.documentElement.style.backgroundColor = initialBg;
  document.body.style.backgroundColor = initialBg;
  if (isDark) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  } else {
    document.documentElement.classList.add("light");
    document.documentElement.classList.remove("dark");
  }
} catch {}

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<div className="w-full min-h-screen bg-[#101010] light:bg-[#e0e0e0]" />}>
      <RouterProvider router={router} />
    </Suspense>
    <Toast />
  </StrictMode>
);

// Comprobación de actualizaciones al iniciar si hay conexión a internet
if (typeof navigator !== "undefined" && navigator.onLine) {
  setTimeout(() => {
    void checkAndApplyUpdate(false);
  }, 2000);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void checkAndApplyUpdate(false);
  });
}
