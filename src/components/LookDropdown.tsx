import { useState, useRef } from "react";
import { ChevronDown, Palette } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import type { NoteLook } from "../types";

/** Extracted out of Editor.tsx so the browser-guest build's own toolbar (see
 * src/browser-guest/BrowserToolbar.tsx) can reuse it without pulling in the rest of that
 * file - pure presentational component, moved verbatim, no logic changes. Persistence is up
 * to the caller (Editor.tsx uses fsNotes.ts's getNoteLook/setNoteLook; the browser-guest
 * build uses a guest-local localStorage equivalent - see browser-guest/noteLook.ts). */

const NOTE_LOOKS: { value: NoteLook; label: string }[] = [
  { value: "plain", label: "Plain" },
  { value: "paper", label: "Paper" },
  { value: "grid", label: "Grid" },
  { value: "index-card", label: "Index card" },
];

export function LookDropdown({ look, onSelect }: { look: NoteLook; onSelect: (look: NoteLook) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const current = NOTE_LOOKS.find((l) => l.value === look) ?? NOTE_LOOKS[0];

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Note look"
        aria-label="Note look"
        aria-expanded={open}
        className="btn-ghost hover:bg-surface-hover flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs"
      >
        <Palette size={13} />
        <span className="max-w-20 truncate">{current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle w-40 overflow-hidden rounded-lg border py-1"
        >
          {NOTE_LOOKS.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => {
                onSelect(l.value);
                setOpen(false);
              }}
              className={`hover:bg-surface-hover flex w-full items-center px-3 py-1.5 text-left text-sm ${
                l.value === look ? "text-accent bg-accent-soft" : "text-primary"
              }`}
            >
              {l.label}
            </button>
          ))}
        </ToolbarPopover>
      )}
    </div>
  );
}
