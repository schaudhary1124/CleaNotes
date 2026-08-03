import { useState, useRef } from "react";
import { ChevronDown, Type } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import type { BlockStyle } from "../milkdown/setup";

/** Extracted out of Editor.tsx so the browser-guest build's own toolbar (see
 * src/browser-guest/BrowserToolbar.tsx) can reuse it without pulling in the rest of that
 * file - pure presentational component, moved verbatim, no logic changes. */

const TEXT_STYLES: { style: BlockStyle; label: string; className: string }[] = [
  { style: "paragraph", label: "Normal text", className: "text-sm" },
  { style: 3, label: "Subheading", className: "text-base font-semibold" },
  { style: 2, label: "Heading", className: "text-lg font-bold" },
  { style: 1, label: "Title", className: "text-xl font-bold" },
];

export function TextStyleDropdown({
  blockStyle,
  onSelect,
}: {
  blockStyle: BlockStyle;
  onSelect: (style: BlockStyle) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const current = TEXT_STYLES.find((s) => s.style === blockStyle) ?? TEXT_STYLES[0];

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Text style"
        aria-label="Text style"
        aria-expanded={open}
        className="btn-ghost hover:bg-surface-hover flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs"
      >
        <Type size={13} />
        <span className="max-w-20 truncate">{current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle w-40 overflow-hidden rounded-lg border py-1"
        >
          {TEXT_STYLES.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                onSelect(s.style);
                setOpen(false);
              }}
              className={`hover:bg-surface-hover flex w-full items-center px-3 py-1.5 text-left ${s.className} ${
                s.style === blockStyle ? "text-accent bg-accent-soft" : "text-primary"
              }`}
            >
              {s.label}
            </button>
          ))}
        </ToolbarPopover>
      )}
    </div>
  );
}
