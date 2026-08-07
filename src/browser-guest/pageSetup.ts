import type { PageSetup } from "../types";

/**
 * Guest-local Fixed-Size page setup, keyed per noteId - fsNotes.ts's getPageSetup/setPageSetup
 * (what the desktop owner uses) persist to a shared meta.json a browser guest has no access to.
 * Same reasoning as noteLook.ts: page size/margins are a per-viewer print/display preference,
 * not note content, so this never rides the collab session and each guest keeps their own.
 */

const DEFAULT_PAGE_SETUP: PageSetup = { size: "a4", orientation: "portrait", marginMm: 14 };

function storageKey(noteId: string): string {
  return `cleanotes:browser-collab:page-setup:${noteId}`;
}

export function loadPageSetup(noteId: string): PageSetup {
  const raw = localStorage.getItem(storageKey(noteId));
  if (!raw) return DEFAULT_PAGE_SETUP;
  try {
    const parsed = JSON.parse(raw) as Partial<PageSetup>;
    if (parsed.size !== "a4" && parsed.size !== "letter" && parsed.size !== "custom") return DEFAULT_PAGE_SETUP;
    if (parsed.orientation !== "portrait" && parsed.orientation !== "landscape") return DEFAULT_PAGE_SETUP;
    if (typeof parsed.marginMm !== "number") return DEFAULT_PAGE_SETUP;
    return {
      size: parsed.size,
      orientation: parsed.orientation,
      marginMm: parsed.marginMm,
      customWidthMm: typeof parsed.customWidthMm === "number" ? parsed.customWidthMm : undefined,
      customHeightMm: typeof parsed.customHeightMm === "number" ? parsed.customHeightMm : undefined,
    };
  } catch {
    return DEFAULT_PAGE_SETUP;
  }
}

export function savePageSetup(noteId: string, setup: PageSetup): void {
  localStorage.setItem(storageKey(noteId), JSON.stringify(setup));
}
