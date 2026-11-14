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
  const [stats, setStats] = useState<FileStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    setLoading(true);

    getFileStats(fileName)
      .then(res => {
        if (isMounted) {
          setStats(res);
          setLoading(false);
        }
      })
      .catch(err => {
        logger.error("Error loading file stats:", err);
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, fileName, getFileStats]);

  const displayName = displayNoteName(fileName);

  return (
    <InfoModal
      isOpen={isOpen}
      onClose={onClose}
      title="Información del archivo"
      icon={Info}
      name={displayName}
    >
      {loading ? (
        <div
          className={`flex flex-col items-center justify-center gap-y-2.5 py-8 text-center text-xs ${
            isDay ? "text-neutral-400" : "text-zinc-500"
          }`}
        >
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin opacity-60" />
          <span>Cargando información...</span>
        </div>
      ) : stats ? (
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
