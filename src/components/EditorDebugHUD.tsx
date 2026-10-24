import { useEffect, useState } from "react";
import { editorDebug, type LogEntry } from "../utils/editorDebug";
import { Bug, ChevronDown, Copy, Download, Trash2 } from "lucide-react";

interface EditorDebugHUDProps {
  startIdx: number;
  endIdx: number;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}

export default function EditorDebugHUD({
  startIdx,
  endIdx,
  textareaRef,
}: EditorDebugHUDProps) {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [feedback, setFeedback] = useState<string>("");

  useEffect(() => {
    setLogs(editorDebug.getRecentLogs(6));
    const unsubscribe = editorDebug.subscribe(() => {
      setLogs(editorDebug.getRecentLogs(6));
    });
    return unsubscribe;
  }, []);

  const handleSave = async () => {
    const msg = await editorDebug.saveToFile();
    setFeedback(msg);
    setTimeout(() => setFeedback(""), 4000);
  };

  const handleCopy = () => {
    const text = editorDebug.getFormattedLogs();
    navigator.clipboard.writeText(text);
    setFeedback("¡Copiado al portapapeles!");
    setTimeout(() => setFeedback(""), 3000);
  };

  const handleClear = () => {
    editorDebug.clear();
    setFeedback("Logs limpiados");
    setTimeout(() => setFeedback(""), 2000);
  };

  const selStart = textareaRef.current?.selectionStart ?? 0;
  const selEnd = textareaRef.current?.selectionEnd ?? 0;

  return (
    <div className="fixed bottom-3 left-3 z-50 font-mono text-xs select-none no-print">
      {!isOpen ? (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-neutral-900/80 hover:bg-neutral-800 text-sky-400 border border-sky-500/40 rounded-md backdrop-blur-md shadow-lg transition-colors cursor-pointer"
        >
          <Bug size={14} />
          <span>Debug Editor</span>
          <span className="text-[10px] text-neutral-400">({startIdx}..{endIdx})</span>
        </button>
      ) : (
        <div className="w-96 max-w-[90vw] bg-neutral-950/95 border border-sky-500/50 rounded-lg shadow-2xl backdrop-blur-md overflow-hidden text-neutral-300">
          <div className="flex items-center justify-between px-3 py-2 bg-neutral-900/90 border-b border-neutral-800">
            <div className="flex items-center gap-2 text-sky-400 font-semibold">
              <Bug size={14} />
              <span>Inspector de Eventos y Foco</span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white"
            >
              <ChevronDown size={14} />
            </button>
          </div>

          <div className="p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2 p-2 bg-neutral-900/60 rounded border border-neutral-800/80 text-[11px]">
              <div>
                <span className="text-neutral-500">Párrafos Activos: </span>
                <span className="text-sky-300 font-bold">[{startIdx} .. {endIdx}]</span>
              </div>
              <div>
                <span className="text-neutral-500">Selección: </span>
                <span className="text-emerald-300 font-bold">{selStart} .. {selEnd}</span>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold flex justify-between">
                <span>Últimos Eventos</span>
                <span className="text-[9px] text-neutral-600">ms desde inicio</span>
              </div>
              <div className="h-32 overflow-y-auto space-y-1 p-1 bg-black/40 rounded border border-neutral-900 font-mono text-[10px]">
                {logs.length === 0 ? (
                  <div className="text-neutral-600 text-center py-4">Sin eventos registrados</div>
                ) : (
                  logs.map((l, i) => (
                    <div key={i} className="flex items-start gap-1.5 leading-tight">
                      <span className="text-neutral-500 text-[9px] min-w-[50px]">{l.timeStr.slice(3)}</span>
                      <span
                        className={
                          l.category === "TRANSITION"
                            ? "text-amber-400 font-semibold"
                            : l.category === "RENDER"
                            ? "text-purple-400"
                            : l.category === "STATE"
                            ? "text-emerald-400 font-semibold"
                            : "text-sky-400"
                        }
                      >
                        [{l.category[0]}]
                      </span>
                      <span className="text-neutral-200 truncate flex-1">{l.name}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {feedback && (
              <div className="text-[10px] text-center text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 rounded py-1">
                {feedback}
              </div>
            )}

            <div className="flex items-center gap-1.5 pt-1 border-t border-neutral-800">
              <button
                type="button"
                onClick={handleSave}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 bg-sky-600 hover:bg-sky-500 text-white rounded text-[11px] font-medium transition cursor-pointer"
              >
                <Download size={12} />
                <span>Guardar Log</span>
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded transition cursor-pointer"
                title="Copiar log"
              >
                <Copy size={13} />
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="p-1.5 bg-neutral-800 hover:bg-rose-900/50 text-neutral-400 hover:text-rose-300 rounded transition cursor-pointer"
                title="Limpiar"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
