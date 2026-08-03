import type { NoteLook } from "../types";

/**
 * Guest-local "Paper" background look, keyed per noteId - fsNotes.ts's getNoteLook/setNoteLook
 * (what Editor.tsx normally uses) persist to the owner's disk via a shared meta.json, which a
 * browser guest has no access to and no reason to write anyway: this is a per-viewer display
 * preference, not note content, so each guest choosing their own independently (never synced
 * to the owner or other guests) is the right default - same reasoning as the theme/accent
 * settings in BrowserSettingsPopover.tsx.
 */

const DEFAULT_LOOK: NoteLook = "plain";

function storageKey(noteId: string): string {
  return `cleanotes:browser-collab:look:${noteId}`;
}

export function loadNoteLook(noteId: string): NoteLook {
  const value = localStorage.getItem(storageKey(noteId));
  return value === "plain" || value === "paper" || value === "grid" || value === "index-card" ? value : DEFAULT_LOOK;
}

export function saveNoteLook(noteId: string, look: NoteLook): void {
  localStorage.setItem(storageKey(noteId), look);
}
