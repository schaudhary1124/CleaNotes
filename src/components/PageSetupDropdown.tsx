import { useRef, useState } from "react";
import { ChevronDown, Ruler } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import type { PageSetup, PageSizeId } from "../types";

/** Fixed-Size notes' page-setup control (size/orientation/margin) - modeled directly on
 * LookDropdown.tsx's shape (button + popover, no internal persistence of its own; the caller
 * owns that - see Editor.tsx's getPageSetup/setPageSetup, browser-guest's loadPageSetup/
 * savePageSetup). Only shown when Editor.tsx's `paginated` prop is set. */

const PAGE_SIZES: { value: PageSizeId; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
  { value: "custom", label: "Custom" },
];

export function PageSetupDropdown({ setup, onChange }: { setup: PageSetup; onChange: (next: PageSetup) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const current = PAGE_SIZES.find((s) => s.value === setup.size) ?? PAGE_SIZES[0];

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Page setup"
        aria-label="Page setup"
        aria-expanded={open}
        className="btn-ghost hover:bg-surface-hover flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs"
      >
        <Ruler size={13} />
        <span className="max-w-20 truncate">{current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle w-56 overflow-hidden rounded-lg border p-2"
        >
          <div className="flex gap-1">
            {PAGE_SIZES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => onChange({ ...setup, size: s.value })}
                className={`flex-1 rounded-md px-2 py-1 text-xs ${
                  s.value === setup.size ? "text-accent bg-accent-soft" : "text-primary hover:bg-surface-hover"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {setup.size === "custom" ? (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <label className="text-secondary flex items-center gap-1">
                W
                <input
                  type="number"
                  min={50}
                  value={setup.customWidthMm ?? 210}
                  onChange={(e) => onChange({ ...setup, customWidthMm: Number(e.target.value) || 0 })}
                  className="bg-surface border-subtle w-16 rounded border px-1.5 py-0.5"
                />
              </label>
              <label className="text-secondary flex items-center gap-1">
                H
                <input
                  type="number"
                  min={50}
                  value={setup.customHeightMm ?? 297}
                  onChange={(e) => onChange({ ...setup, customHeightMm: Number(e.target.value) || 0 })}
                  className="bg-surface border-subtle w-16 rounded border px-1.5 py-0.5"
                />
              </label>
              <span className="text-tertiary">mm</span>
            </div>
          ) : (
            <div className="mt-2 flex gap-1">
              {(["portrait", "landscape"] as const).map((orientation) => (
                <button
                  key={orientation}
                  type="button"
                  onClick={() => onChange({ ...setup, orientation })}
                  className={`flex-1 rounded-md px-2 py-1 text-xs capitalize ${
                    orientation === setup.orientation ? "text-accent bg-accent-soft" : "text-primary hover:bg-surface-hover"
                  }`}
                >
                  {orientation}
                </button>
              ))}
            </div>
          )}
        </ToolbarPopover>
      )}
    </div>
  );
}
