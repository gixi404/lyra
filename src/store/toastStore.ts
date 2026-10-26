import { create } from "zustand";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  msg: string;
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastMessage[];
  addToast: (
    type: "success" | "error" | "info",
    msg: string,
    action?: ToastAction,
    durationMs?: number
  ) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

export const useToastStore = create<ToastStore>(set => ({
  toasts: [],
  addToast: (type, msg, action, durationMs = 2500) => {
    const id = Math.random().toString(36).substring(2, 9);
    set(state => ({ toasts: [...state.toasts, { id, type, msg, action }] }));
    if (durationMs > 0) {
      setTimeout(() => {
        set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }));
      }, durationMs);
    }
    return id;
  },
  removeToast: id =>
    set(state => ({ toasts: state.toasts.filter(t => t.id !== id) })),
  clearToasts: () => set({ toasts: [] }),
}));
