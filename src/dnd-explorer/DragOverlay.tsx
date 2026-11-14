import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { ExplorerDndState } from "./useExplorerDnd.ts";

export default function DragOverlay({ dnd, children }: { dnd: ExplorerDndState; children: React.ReactNode }) {
  if (!dnd.dragging || !dnd.pointer || !dnd.cloneSize) return null;
  const fromX = dnd.pointer.x - dnd.cloneOffset.x;
  const fromY = dnd.pointer.y - dnd.cloneOffset.y;
  const finishing = dnd.finishing;
  const x = finishing ? finishing.toX : fromX;
  const y = finishing ? finishing.toY : fromY;
  return createPortal(
    <motion.div
      initial={false}
      animate={{
        x,
        y,
        scale: finishing ? (finishing.type === "drop" ? 0.96 : 1) : 1,
        opacity: finishing && finishing.type === "drop" ? 0.85 : 0.96,
      }}
      transition={finishing ? { duration: finishing.type === "cancel" ? 0.18 : 0.14, ease: [0.32, 0.72, 0.35, 1] } : { duration: 0 }}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: dnd.cloneSize.width,
        height: dnd.cloneSize.height,
        pointerEvents: "none",
        zIndex: 9999,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        borderRadius: 8,
      }}
      aria-hidden="true"
    >
      {children}
    </motion.div>,
    document.body
  );
}
