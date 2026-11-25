import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DndPrototype from "../pages/DndPrototype.tsx";

createRoot(document.getElementById("root")!).render(<StrictMode><DndPrototype /></StrictMode>);
