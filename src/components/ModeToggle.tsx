import { GraduationCap, Pencil } from "lucide-react";
import type { AppMode } from "../types";

interface ModeToggleProps {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
}

const MODES: { value: AppMode; label: string; icon: typeof Pencil }[] = [
  { value: "edit", label: "Edit", icon: Pencil },
  { value: "study", label: "Study", icon: GraduationCap },
];

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const activeIndex = MODES.findIndex((m) => m.value === mode);

  return (
    <div
      role="tablist"
      aria-label="Toggle between Edit and Study mode"
      className="glass-surface relative flex h-8 w-36 shrink-0 items-center overflow-hidden rounded-full border-0 p-1 text-xs font-medium @max-lg:w-16"
    >
      <span
        className="bg-accent-solid shadow-app absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] rounded-full transition-transform duration-200 ease-out"
        style={{ transform: activeIndex === 1 ? "translateX(100%)" : "translateX(0)" }}
      />
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          role="tab"
          aria-selected={mode === m.value}
          onClick={() => onChange(m.value)}
          title={m.label}
          className={`z-10 flex flex-1 items-center justify-center gap-1.5 rounded-full py-1 text-center whitespace-nowrap transition-colors duration-150 ${
            mode === m.value ? "text-white" : "text-secondary"
          }`}
        >
          <m.icon size={12} className="shrink-0" />
          <span className="@max-lg:hidden">{m.label}</span>
        </button>
      ))}
    </div>
  );
}
