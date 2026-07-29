/**
 * Persists which notes are open as tabs, and which is active, for the main
 * window only. Tauri windows share one localStorage, so an unscoped key
 * would collide if multiple windows were open at once - secondary windows
 * (duplicated or detached) are ephemeral and never restored on relaunch, so
 * only "main" needs to read/write this.
 */
const KEY = "cleanotes:tabs:main";
// Pre-rename key (app was called PlaiNotes through v0.1.0) - read as a fallback
// in loadMainTabSession so an in-progress session survives the rename.
const LEGACY_KEY = "plainotes:tabs:main";

interface MainTabSession {
  tabs: string[];
  activePath: string | null;
}

export function loadMainTabSession(): MainTabSession | null {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tabs)) return null;
    return {
      tabs: parsed.tabs.filter((p: unknown) => typeof p === "string"),
      activePath: typeof parsed.activePath === "string" ? parsed.activePath : null,
    };
  } catch {
    return null;
  }
}

export function saveMainTabSession(tabs: string[], activePath: string | null): void {
  localStorage.setItem(KEY, JSON.stringify({ tabs, activePath }));
}
