import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";

/** Extracted out of Editor.tsx so the browser-guest build's own toolbar (see
 * src/browser-guest/BrowserToolbar.tsx) can reuse it without pulling in the rest of that
 * file - pure presentational component, moved verbatim, no logic changes. */
export type ToolbarAction = {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  action: () => void;
  isActive?: boolean;
  disabled?: boolean;
};

/** Combines related actions (e.g. Bold/Italic) into a single button: clicking
 * it runs the currently-active (or last-picked) action, and hovering reveals
 * the full set so the user can switch to a different one. */
export function ToolbarButtonGroup({ items }: { items: ToolbarAction[] }) {
  const [open, setOpen] = useState(false);
  const [lastIndex, setLastIndex] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeIndex = items.findIndex((item) => item.isActive);
  const current = items[activeIndex >= 0 ? activeIndex : lastIndex];
  const allDisabled = items.every((item) => item.disabled);

  const openNow = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }, []);
  const closeSoon = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }, []);
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <div ref={anchorRef} className="relative flex shrink-0" onMouseEnter={allDisabled ? undefined : openNow} onMouseLeave={closeSoon}>
      <button
        type="button"
        disabled={current.disabled}
        onClick={() => {
          setLastIndex(items.indexOf(current));
          current.action();
        }}
        title={current.label}
        aria-label={current.label}
        aria-pressed={activeIndex >= 0}
        className={`btn-ghost relative h-7 w-7 shrink-0 ${activeIndex >= 0 ? "bg-accent-soft text-accent" : ""} ${current.disabled ? "cursor-not-allowed opacity-40" : ""}`}
      >
        <current.icon size={14} />
        <ChevronDown size={8} className="absolute bottom-0 right-0 opacity-50" />
      </button>
      {open && !allDisabled && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle inline-flex overflow-hidden rounded-lg border p-1"
        >
          <div className="flex items-center gap-0.5" onMouseEnter={openNow} onMouseLeave={closeSoon}>
            {items.map((item, idx) => (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setLastIndex(idx);
                  item.action();
                  setOpen(false);
                }}
                title={item.label}
                aria-label={item.label}
                aria-pressed={item.isActive}
                className={`btn-ghost h-7 w-7 shrink-0 ${item.isActive ? "bg-accent-soft text-accent" : ""} ${item.disabled ? "cursor-not-allowed opacity-40" : ""}`}
              >
                <item.icon size={14} />
              </button>
            ))}
          </div>
        </ToolbarPopover>
      )}
    </div>
  );
}
