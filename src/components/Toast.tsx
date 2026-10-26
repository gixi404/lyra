import { useToastStore } from "../store/toastStore";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
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
          style={{
            backgroundColor: isDay ? "#ffffff" : "#18181b",
            opacity: 1,
          }}
          className={`flex items-center gap-x-2.5 px-3.5 py-2.5 rounded-xl border text-xs font-medium animate-in fade-in slide-in-from-top-2 duration-150 pointer-events-auto ${
            isDay
              ? "text-neutral-900 border-neutral-300 shadow-xl shadow-neutral-400/40"
              : "text-zinc-100 border-zinc-700 shadow-2xl shadow-black/80"
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
          {Boolean(t.msg) && <span className="select-none">{t.msg}</span>}
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                removeToast(t.id);
              }}
              className={`${
                t.msg ? "ml-1" : ""
              } ${
                isDay
                  ? "text-sky-600 hover:text-sky-700 decoration-sky-600/50 hover:decoration-sky-700"
                  : "text-sky-400 hover:text-sky-300 decoration-sky-400/50 hover:decoration-sky-300"
              } underline underline-offset-2 font-semibold cursor-pointer transition-all duration-150 outline-none hover:brightness-110 active:scale-95`}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => removeToast(t.id)}
            className="ml-1.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-zinc-200 transition-colors p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-zinc-800 cursor-pointer shrink-0"
            title="Cerrar notificación"
            aria-label="Cerrar notificación"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export default Toast;
