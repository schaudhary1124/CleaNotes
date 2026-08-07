import type { AppSettings, FeatureFlags } from "../types";

const STORAGE_KEY = "cleanotes:settings";
// Pre-rename key (app was called PlaiNotes through v0.1.0) - read as a fallback
// in loadSettings so existing settings survive the rename, never written to again.
const LEGACY_STORAGE_KEY = "plainotes:settings";

// All on by default - the toggles are opt-out, so existing users see no change until they
// visit Settings themselves.
export const DEFAULT_FEATURES: FeatureFlags = {
  calendar: true,
  sketch: true,
  studyMode: true,
  codeBlock: true,
  keepOnTop: true,
  voiceNotes: true,
};

/** Bounds for AppSettings.voiceNoteCountdown - shared by the Settings stepper that edits it and
 * loadSettings' sanitizing of whatever was persisted. */
export const VOICE_COUNTDOWN_MIN = 0;
export const VOICE_COUNTDOWN_MAX = 10;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  accent: "indigo",
  background: "flat",
  toolbarCollapsed: false,
  sidebarCollapsed: false,
  alwaysOnTop: false,
  features: DEFAULT_FEATURES,
  voiceNoteCountdown: 3,
};

export function clampVoiceCountdown(value: unknown): number {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds)) return DEFAULT_SETTINGS.voiceNoteCountdown;
  return Math.min(VOICE_COUNTDOWN_MAX, Math.max(VOICE_COUNTDOWN_MIN, seconds));
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    // `features` merges one level deeper than the rest - stored settings from before this field
    // existed (or missing a flag added later) shouldn't silently disable every feature within it.
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      features: { ...DEFAULT_FEATURES, ...parsed.features },
    };
    // Re-clamped rather than trusted: this one is a number a hand-edited (or older, differently-
    // bounded) stored value could put out of range, and a negative/absurd countdown would stall
    // the recorder popover before it ever reached the microphone.
    merged.voiceNoteCountdown = clampVoiceCountdown(merged.voiceNoteCountdown);
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Reflects the current settings onto <html> as data-attributes consumed by index.css */
export function applySettingsToDocument(settings: AppSettings): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", settings.theme);
  root.setAttribute("data-bg", settings.background);
  root.setAttribute("data-accent", settings.accent);
}
