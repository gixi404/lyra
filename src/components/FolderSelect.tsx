import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { ChevronDown, Plus } from "lucide-react";
import { configStore } from "../store/configStore.ts";
import { themes } from "../utils/helpers";
import { computeMenuPosition, isSameMenuPosition, type MenuPlacement } from "../utils/menuPosition.ts";
import { folderListDepthPx } from "../utils/folderIndent.ts";
import { displayFolderName } from "../utils/visibleNames.ts";
import { getFolderIconColors, getFolderIcons, getFolderTextColors, resolveFolderColor, resolveFolderIcon } from "../utils/folderAppearance.ts";

const FALLBACK_LIST_HEIGHT = 240;

export default function FolderSelect({ folders, value, onChange, onNewFolder, disabled = false, allowRoot = true }: {
  folders: string[];
  value: string;
  onChange: (path: string) => void;
  onNewFolder: () => void;
  disabled?: boolean;
  allowRoot?: boolean;
}): JSX.Element {
  const { isDay } = themes();
  const prefTick = configStore(state => state.prefTick);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read appearance on preference changes
  const folderTextColors = useMemo(() => getFolderTextColors(), [prefTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read appearance on preference changes
  const folderIconColors = useMemo(() => getFolderIconColors(), [prefTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read appearance on preference changes
  const folderIcons = useMemo(() => getFolderIcons(), [prefTick]);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement>("bottom");
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [menuHeight, setMenuHeight] = useState<number>(FALLBACK_LIST_HEIGHT);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const transitions = useTransition(open, {
    from: { opacity: 0, transform: `scale(0.96) translateY(${placement === "top" ? "-4px" : "4px"})` },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: `scale(0.96) translateY(${placement === "top" ? "-4px" : "4px"})` },
    config: { duration: 150 },
  });

  const updatePosition = useCallback((preferred?: MenuPlacement): void => {
    const trigger = buttonRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const panel = listRef.current;
    const result = computeMenuPosition({
      anchor: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      menu: {
        width: rect.width,
        height: panel?.offsetHeight || menuHeight,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      align: "start",
      preferredPlacement: preferred,
    });
    setPosition(previous =>
      isSameMenuPosition(previous, result)
        ? previous
        : { top: result.top, left: result.left }
    );
    setPlacement(result.placement);
  }, [menuHeight]);

  function toggle(): void {
    if (disabled) return;
    if (!open) {
      const trigger = buttonRef.current;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const result = computeMenuPosition({
          anchor: {
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          menu: { width: rect.width, height: menuHeight },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          align: "start",
        });
        setPlacement(result.placement);
        setPosition({ top: result.top, left: result.left });
      }
    }
    setOpen(previous => !previous);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const measured = listRef.current?.offsetHeight ?? 0;
    if (measured && measured !== menuHeight) setMenuHeight(measured);
    updatePosition(placement);
  }, [open, placement, updatePosition, menuHeight]);

  useEffect(() => {
    if (!open) return;
    const handleViewportChange = (): void => updatePosition(placement);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, placement, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const label = value === "" ? displayFolderName("") : displayFolderName(value);
  const selectedTextColor = resolveFolderColor(folderTextColors[value], isDay);
  const selectedIconColor = resolveFolderColor(folderIconColors[value], isDay);
  const SelectedIcon = resolveFolderIcon(folderIcons[value]);

  function select(path: string) {
    onChange(path);
    setOpen(false);
    buttonRef.current?.focus();
  }

  const triggerWidth = buttonRef.current?.getBoundingClientRect().width ?? 0;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        className={`w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
          isDay ? "bg-neutral-50 border-neutral-300 text-neutral-900" : "bg-zinc-800/80 border-zinc-700 text-zinc-100"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "hover:border-sky-500"}`}
      >
        <span className="flex items-center gap-2 truncate min-w-0" style={selectedTextColor ? { color: selectedTextColor } : undefined}>
          <SelectedIcon size={16} style={selectedIconColor ? { color: selectedIconColor } : undefined} />
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {transitions((styles, item) =>
        item && createPortal(
          <>
            <div className="fixed inset-0 z-[9998]" onMouseDown={() => setOpen(false)} />
            <animated.ul
              ref={listRef}
              role="listbox"
              className={`fixed z-[9999] max-h-64 overflow-y-auto rounded-xl border shadow-2xl py-1 ${
                isDay ? "bg-white border-neutral-200 text-neutral-900" : "bg-zinc-900 border-zinc-800 text-zinc-100"
              }`}
              style={{
                opacity: styles.opacity,
                transform: styles.transform,
                transformOrigin: placement === "top" ? "bottom left" : "top left",
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                width: triggerWidth || buttonRef.current?.offsetWidth || undefined,
              }}
            >
              <li>
                <button
                  type="button"
                  onClick={() => { onNewFolder(); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                    isDay ? "hover:bg-neutral-100" : "hover:bg-zinc-800"
                  }`}
                >
                  <Plus size={16} />
                  Nueva carpeta
                </button>
              </li>
              {allowRoot && (
                <li>
                  {(() => {
                    const rootTextColor = resolveFolderColor(folderTextColors[""], isDay);
                    const rootIconColor = resolveFolderColor(folderIconColors[""], isDay);
                    const RootIcon = resolveFolderIcon(folderIcons[""]);
                    return (
                      <button
                        type="button"
                        onClick={() => select("")}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                          value === "" ? (isDay ? "bg-neutral-100" : "bg-zinc-800") : ""
                        } ${isDay ? "hover:bg-neutral-100" : "hover:bg-zinc-800"}`}
                        style={{ paddingLeft: 12, ...(rootTextColor ? { color: rootTextColor } : {}) }}
                      >
                        <RootIcon size={16} style={rootIconColor ? { color: rootIconColor } : undefined} />
                        <span className="truncate">{displayFolderName("")}</span>
                      </button>
                    );
                  })()}
                </li>
              )}
              {folders.map(folder => {
                const textColor = resolveFolderColor(folderTextColors[folder], isDay);
                const iconColor = resolveFolderColor(folderIconColors[folder], isDay);
                const Icon = resolveFolderIcon(folderIcons[folder]);
                return (
                  <li key={folder}>
                    <button
                      type="button"
                      onClick={() => select(folder)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                        value === folder ? (isDay ? "bg-neutral-100" : "bg-zinc-800") : ""
                      } ${isDay ? "hover:bg-neutral-100" : "hover:bg-zinc-800"}`}
                      style={{ paddingLeft: folderListDepthPx(folder), ...(textColor ? { color: textColor } : {}) }}
                    >
                      <Icon size={16} style={iconColor ? { color: iconColor } : undefined} />
                      <span className="truncate">{displayFolderName(folder)}</span>
                    </button>
                  </li>
                );
              })}
            </animated.ul>
          </>,
          document.body
        )
      )}
    </div>
  );
}
