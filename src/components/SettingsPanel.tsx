import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Calendar,
  Check,
  Code,
  Download,
  GraduationCap,
  Mic,
  Pin,
  RefreshCw,
  RotateCcw,
  Brush,
} from "lucide-react";
import type { AppSettings, FeatureFlags, ThemeName } from "../types";
import type { AppUpdaterState } from "../hooks/useAppUpdater";
import { Switch } from "./Switch";

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
  updaterState: AppUpdaterState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onRestart: () => void;
}

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

const FEATURES: { key: keyof FeatureFlags; label: string; description: string; icon: typeof Calendar }[] = [
  { key: "calendar", label: "Calendar", description: "Mini calendar in the sidebar", icon: Calendar },
  { key: "sketch", label: "Sketch", description: "Freehand drawing on top of notes", icon: Brush },
  { key: "studyMode", label: "Study Mode", description: "Flashcards and quizzes for a note", icon: GraduationCap },
  { key: "codeBlock", label: "Code Block", description: "Insert syntax-highlighted code blocks", icon: Code },
  { key: "keepOnTop", label: "Keep window on top", description: "Pin this window above others", icon: Pin },
  { key: "voiceNotes", label: "Voice Notes", description: "Record audio notes inline", icon: Mic },
];

export function SettingsPanel({
  settings,
  onChange,
  onClose,
  updaterState,
  onCheckForUpdates,
  onInstallUpdate,
  onRestart,
}: SettingsPanelProps) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // Set the moment a manual check is kicked off, so once the phase settles back to "idle" we
  // know that was in response to this check (rather than just the hook's initial idle state) and
  // can show "You're up to date" instead of nothing.
  const justCheckedRef = useRef(false);
  const [justCheckedIdle, setJustCheckedIdle] = useState(false);

  useEffect(() => {
    void getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    if (updaterState.phase === "checking") {
      justCheckedRef.current = true;
      setJustCheckedIdle(false);
    } else if (updaterState.phase === "idle" && justCheckedRef.current) {
      justCheckedRef.current = false;
      setJustCheckedIdle(true);
    } else if (updaterState.phase !== "idle") {
      setJustCheckedIdle(false);
    }
  }, [updaterState.phase]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function toggleFeature(key: keyof FeatureFlags) {
    onChange({ ...settings, features: { ...settings.features, [key]: !settings.features[key] } });
  }

  // The button drives whatever action the current phase calls for, rather than only ever
  // re-checking - so the user explicitly opts in to each step (download, then restart).
  const updateButton = (() => {
    switch (updaterState.phase) {
      case "checking":
        return { label: "Checking…", icon: RefreshCw, spin: true, disabled: true, onClick: onCheckForUpdates };
      case "available":
        return {
          label: `Update to v${updaterState.version}`,
          icon: Download,
          spin: false,
          disabled: false,
          onClick: onInstallUpdate,
        };
      case "downloading":
        return { label: "Downloading…", icon: Download, spin: true, disabled: true, onClick: onInstallUpdate };
      case "ready":
        return { label: "Restart Application", icon: RotateCcw, spin: false, disabled: false, onClick: onRestart };
      default:
        return { label: "Check for Updates", icon: RefreshCw, spin: false, disabled: false, onClick: onCheckForUpdates };
    }
  })();

  return (
    <div className="glass-panel shadow-app animate-fade-in relative flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-md p-5 @max-sm:p-4">
        <div className="border-subtle mb-4 border-b pb-3">
          <p className="text-primary text-base font-semibold">Settings</p>
        </div>

        <div className="space-y-5">
          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Theme
            </p>
            <div className="flex gap-2">
              {THEMES.map((theme) => (
                <button
                  key={theme.value}
                  type="button"
                  onClick={() => onChange({ ...settings, theme: theme.value })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors duration-150 ${
                    settings.theme === theme.value
                      ? "border-accent-soft bg-accent-soft text-accent font-medium"
                      : "border-subtle text-secondary hover:bg-surface-hover"
                  }`}
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Accent color
            </p>
            <div className="flex flex-wrap gap-3">
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
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110"
                    style={{
                      backgroundColor: accent.color,
                      boxShadow: selected ? `0 0 0 2px var(--surface-strong), 0 0 0 4px ${accent.color}` : "none",
                    }}
                  >
                    {selected && <Check size={14} className="text-white" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Features
            </p>
            <div className="space-y-1">
              {FEATURES.map((feature) => (
                <div
                  key={feature.key}
                  className="border-subtle flex items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <feature.icon size={16} className="text-secondary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-primary text-sm font-medium">{feature.label}</p>
                    <p className="text-tertiary text-xs">{feature.description}</p>
                  </div>
                  <Switch
                    checked={settings.features[feature.key]}
                    onChange={() => toggleFeature(feature.key)}
                    label={`Toggle ${feature.label}`}
                  />
                </div>
              ))}
            </div>
          </section>

          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Updates
            </p>
            <div className="border-subtle flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-primary text-sm font-medium">
                  {appVersion ? `CleaNotes v${appVersion}` : "CleaNotes"}
                </p>
                <p className="text-tertiary text-xs">
                  {updaterState.phase === "checking" && "Checking for updates…"}
                  {updaterState.phase === "idle" && justCheckedIdle && "You're up to date"}
                  {updaterState.phase === "idle" && !justCheckedIdle && "Check for the latest version"}
                  {updaterState.phase === "available" && `Update available — v${updaterState.version}`}
                  {updaterState.phase === "downloading" && "Downloading update…"}
                  {updaterState.phase === "ready" && "Update ready — restart to install"}
                  {updaterState.phase === "error" && "Couldn't check for updates"}
                </p>
              </div>
              <button
                type="button"
                onClick={updateButton.onClick}
                disabled={updateButton.disabled}
                className="btn-ghost border-subtle flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                <updateButton.icon size={13} className={updateButton.spin ? "animate-spin" : ""} />
                {updateButton.label}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
