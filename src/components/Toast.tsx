import { useToastStore } from "../store/toastStore";
import { CheckCircle2, AlertCircle, Info } from "lucide-react";
import { themes } from "../utils/helpers";

function Toast(): JSX.Element | null {
  const toasts = useToastStore(state => state.toasts);
  const removeToast = useToastStore(state => state.removeToast);
  const { isDay } = themes();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[99999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`flex items-center gap-x-2.5 px-4 py-2.5 rounded-xl shadow-xl border text-xs font-medium animate-in fade-in slide-in-from-top-2 duration-150 pointer-events-auto ${
            isDay
              ? "bg-white/95 text-neutral-800 border-neutral-200 shadow-neutral-300/40 backdrop-blur-md"
              : "bg-zinc-900/95 text-zinc-100 border-zinc-700/80 shadow-black/50 backdrop-blur-md"
          }`}
        >
          {t.type === "success" && (
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          )}
          {t.type === "error" && (
            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
          )}
          {t.type === "info" && (
            <Info className="w-4 h-4 text-sky-500 shrink-0" />
          )}
          <span>{t.msg}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                removeToast(t.id);
              }}
              className="ml-1 text-sky-400 hover:text-sky-300 underline font-semibold cursor-pointer transition-colors outline-none"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default Toast;
