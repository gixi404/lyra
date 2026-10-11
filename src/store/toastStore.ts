import { create } from "zustand";

interface ToastMessage {
  id: string;
  type: "success" | "error";
  msg: string;
}

interface ToastStore {
  toasts: ToastMessage[];
  addToast: (type: "success" | "error", msg: string) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>(set => ({
  toasts: [],
  addToast: (type, msg) => {
    const id = Math.random().toString(36).substring(2, 9);
    set(state => ({ toasts: [...state.toasts, { id, type, msg }] }));
    setTimeout(() => {
      set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }));
    }, 2500);
  },
  removeToast: id =>
    set(state => ({ toasts: state.toasts.filter(t => t.id !== id) })),
}));
