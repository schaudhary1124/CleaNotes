import type { AppSettings } from "../types";

const STORAGE_KEY = "plainotes:settings";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  accent: "indigo",
  background: "soft",
  toolbarCollapsed: false,
  sidebarCollapsed: false,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
