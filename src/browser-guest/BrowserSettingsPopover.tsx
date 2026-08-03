import { useRef, useState } from "react";
import { Check, Settings } from "lucide-react";
import { ToolbarPopover } from "../components/ToolbarPopover";
import type { AppSettings, ThemeName } from "../types";

/**
 * Guest-local Theme/Accent picker - a small popover instead of SettingsPanel.tsx (which pulls
 * in @tauri-apps/api/app for the version string, and collab/acl.ts for the shared-notes list -
 * neither belongs in the browser build). Only the two sections actually asked for; not a port
 * of the whole panel. Own localStorage via utils/settings.ts, used as-is - that module has zero
 * Tauri imports, and this is a per-browser preference the same way the PIN/display-name and
 * "Paper" look already are, independent of the owner's own desktop settings.
 */

const THEMES: { value: ThemeName; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "midnight", label: "Midnight" },
];

const ACCENTS = [
  { value: "indigo", color: "rgb(99 102 241)" },
  { value: "violet", color: "rgb(139 92 246)" },
  { value: "blue", color: "rgb(59 130 246)" },
  { value: "rose", color: "rgb(244 63 94)" },
  { value: "amber", color: "rgb(217 119 6)" },
  { value: "emerald", color: "rgb(5 150 105)" },
];

interface BrowserSettingsPopoverProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

export function BrowserSettingsPopover({ settings, onChange }: BrowserSettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Theme"
        aria-label="Theme"
        aria-expanded={open}
        className="btn-ghost h-7 w-7 shrink-0"
      >
        <Settings size={14} />
      </button>
      {open && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle w-56 overflow-hidden rounded-lg border p-3"
        >
          <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">Theme</p>
          <div className="flex gap-2">
            {THEMES.map((theme) => (
              <button
                key={theme.value}
                type="button"
                onClick={() => onChange({ ...settings, theme: theme.value })}
                className={`flex-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors duration-150 ${
                  settings.theme === theme.value
                    ? "border-accent-soft bg-accent-soft text-accent font-medium"
                    : "border-subtle text-secondary hover:bg-surface-hover"
                }`}
              >
                {theme.label}
              </button>
            ))}
          </div>

          <p className="text-secondary mb-2 mt-3 text-xs font-semibold uppercase tracking-wider">Accent color</p>
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((accent) => {
              const selected = settings.accent === accent.value;
              return (
                <button
                  key={accent.value}
                  type="button"
                  onClick={() => onChange({ ...settings, accent: accent.value })}
                  title={accent.value}
                  aria-label={`Accent ${accent.value}`}
                  aria-pressed={selected}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110"
                  style={{
                    backgroundColor: accent.color,
                    boxShadow: selected ? `0 0 0 2px var(--surface-strong), 0 0 0 4px ${accent.color}` : "none",
                  }}
                >
                  {selected && <Check size={12} className="text-white" strokeWidth={3} />}
                </button>
              );
            })}
          </div>
        </ToolbarPopover>
      )}
    </div>
  );
}
