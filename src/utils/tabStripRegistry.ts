import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Lets every CleaNotes window know where every other window's tab strip
 * currently sits on screen, so a tab being dragged out of one window can be
 * dropped onto a different window's tab strip to merge into it (see
 * TabStrip.tsx's finishDetach). Each window broadcasts its own rect (or
 * clears it) whenever it moves, resizes, or its tab strip mounts/unmounts -
 * and, since a window can open *after* others already broadcast, a mounting
 * strip also sends a catch-up request that every other live strip answers.
 */
const TABSTRIP_RECT_EVENT = "cleanotes://tabstrip-rect";
const TABSTRIP_RECT_REMOVE_EVENT = "cleanotes://tabstrip-rect-removed";
const TABSTRIP_RECT_REQUEST_EVENT = "cleanotes://tabstrip-rect-request";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RectPayload {
  label: string;
  rect: ScreenRect;
}

interface RemovePayload {
  label: string;
}

const registry = new Map<string, ScreenRect>();
let listeningPromise: Promise<void> | null = null;

/** Starts tracking other windows' rects. Resolves once the listeners are actually registered,
 * so callers can rely on not missing a fast reply to a request they send right after. */
function ensureListening(): Promise<void> {
  if (!listeningPromise) {
    const ownLabel = getCurrentWindow().label;
    listeningPromise = Promise.all([
      listen<RectPayload>(TABSTRIP_RECT_EVENT, (event) => {
        if (event.payload.label === ownLabel) return;
        console.log("[tabstrip] registry: received rect from", event.payload.label, event.payload.rect);
        registry.set(event.payload.label, event.payload.rect);
      }),
      listen<RemovePayload>(TABSTRIP_RECT_REMOVE_EVENT, (event) => {
        console.log("[tabstrip] registry: removed rect for", event.payload.label);
        registry.delete(event.payload.label);
      }),
    ]).then(() => undefined);
  }
  return listeningPromise;
}

/** Live map of every *other* window's current tab-strip screen rect. */
export async function otherTabStripRects(): Promise<ReadonlyMap<string, ScreenRect>> {
  await ensureListening();
  return registry;
}

/** Broadcasts this window's tab-strip rect, or clears it (pass `null` when the strip unmounts). */
export async function broadcastTabStripRect(rect: ScreenRect | null): Promise<void> {
  await ensureListening();
  const label = getCurrentWindow().label;
  if (rect) await emit(TABSTRIP_RECT_EVENT, { label, rect } satisfies RectPayload);
  else await emit(TABSTRIP_RECT_REMOVE_EVENT, { label } satisfies RemovePayload);
}

/** Asks every window with an open tab strip to (re)broadcast its rect right now - a strip
 * calls this once it's listening, to catch up on strips that were already open. */
export async function requestTabStripRects(): Promise<void> {
  await ensureListening();
  await emit(TABSTRIP_RECT_REQUEST_EVENT);
}

/** Lets a mounted strip answer catch-up requests from windows that started listening after
 * this one already broadcast its rect. */
export function onTabStripRectRequested(handler: () => void): Promise<() => void> {
  return listen(TABSTRIP_RECT_REQUEST_EVENT, handler);
}

export function pointInRect(point: { x: number; y: number }, rect: ScreenRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
