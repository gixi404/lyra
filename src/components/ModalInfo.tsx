import { useEffect, useState } from "react";
import {
  Info,
  FileText,
  Calendar,
  HardDrive,
  Type,
  Clock,
  AlignLeft,
  Hash,
} from "lucide-react";
import useFile, { type FileStats } from "../hooks/useFile.ts";
import { themes } from "../utils/helpers.ts";
import { displayNoteName } from "../utils/visibleNames.ts";
import type { Component } from "../utils/types.ts";
import { logger } from "../utils/logger.ts";
import InfoModal, { InfoRow } from "./InfoModal.tsx";

interface ModalInfoProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
}

function ModalInfo({ isOpen, onClose, fileName }: ModalInfoProps): Component {
  const { isDay } = themes();
  const { getFileStats } = useFile();
  const [result, setResult] = useState<{ fileName: string; stats: FileStats | null } | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;

    getFileStats(fileName)
      .then(res => {
        if (isMounted) {
          setResult({ fileName, stats: res });
          setClosing(false);
        }
      })
      .catch(err => {
        logger.error("Error loading file stats:", err);
        if (isMounted) {
          setResult({ fileName, stats: null });
          setClosing(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, fileName, getFileStats]);

  const displayName = displayNoteName(fileName);
  const stats = result?.fileName === fileName ? result.stats : null;
  const close = () => {
    setClosing(true);
    onClose();
  };

  return (
    <InfoModal
      isOpen={isOpen && !closing && result?.fileName === fileName}
      onClose={close}
      title="Información del archivo"
      icon={Info}
      name={displayName}
    >
      {stats ? (
        <div className="flex flex-col gap-y-2 text-xs">
          <InfoRow
            icon={FileText}
            label="Extensión"
            value={
              <span
                className={`font-mono font-medium uppercase px-2 py-0.5 rounded ${
                  isDay ? "bg-neutral-100 text-neutral-800" : "bg-zinc-800 text-zinc-200"
                }`}
              >
                {stats.extension}
              </span>
            }
          />

          <InfoRow icon={HardDrive} label="Peso" value={stats.sizeFormatted} />

          <InfoRow icon={Clock} label="Tiempo de lectura" value={stats.readingTime} />

          <InfoRow icon={Type} label="Cantidad de palabras" value={stats.wordCount} />

          <InfoRow icon={Hash} label="Cantidad de caracteres" value={stats.charCount} />

          <InfoRow icon={AlignLeft} label="Cantidad de párrafos" value={stats.paragraphCount} />

          <InfoRow icon={Calendar} label="Última edición" value={stats.modifiedAt} />

          <InfoRow icon={Calendar} label="Fecha de creación" value={stats.createdAt} last />
        </div>
      ) : (
        <div className="py-4 text-center text-xs text-rose-500">
          No se pudo obtener la información.
        </div>
      )}
    </InfoModal>
  );
}

export default ModalInfo;
