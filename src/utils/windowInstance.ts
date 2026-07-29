import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, once } from "@tauri-apps/api/event";

/** Query param key used to tell a freshly opened window which note to show. */
const NOTE_QUERY_PARAM = "note";
/** Marks a window as spawned mid tab-drag, so its boot sequence knows to wait
 * for a `DETACH_INIT_EVENT` handoff instead of reading the note straight off disk. */
const DETACHED_QUERY_PARAM = "detached";

const DEFAULT_WIDTH = 1180;
const DEFAULT_HEIGHT = 760;

interface LocationTarget {
  /** Note path to open directly into, if this window was spawned to show a specific note - null
   * means it should just boot to Home, like the main window does. */
  notePath: string | null;
  /** True if this window was spawned by dragging a tab out - see DETACH_INIT_EVENT. */
  detached: boolean;
}

/** Reads which note a window should open to, from its own URL (set by openWindowInstance). */
export function getTargetFromLocation(): LocationTarget {
  const params = new URLSearchParams(window.location.search);
  const note = params.get(NOTE_QUERY_PARAM);
  return {
    notePath: note ? decodeURIComponent(note) : null,
    detached: params.get(DETACHED_QUERY_PARAM) === "1",
  };
}

/** Logical (CSS-pixel) size of the current window, falling back to the launch default. */
async function logicalSizeOfCurrentWindow(): Promise<{ width: number; height: number }> {
  try {
    const current = getCurrentWindow();
    const [outerSize, scaleFactor] = await Promise.all([current.outerSize(), current.scaleFactor()]);
    const logical = outerSize.toLogical(scaleFactor);
    return { width: logical.width, height: logical.height };
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
}

/**
 * Opens a new CleaNotes window, sized to match the current window - straight into a specific
 * note if given one, or to Home otherwise (mirrors how the main window itself boots).
 */
export async function openWindowInstance(target?: { notePath: string }): Promise<void> {
  const query = target?.notePath ? `?${NOTE_QUERY_PARAM}=${encodeURIComponent(target.notePath)}` : "";

  const { width, height } = await logicalSizeOfCurrentWindow();

  const label = `note-${crypto.randomUUID()}`;
  new WebviewWindow(label, {
    url: `index.html${query}`,
    title: "CleaNotes",
    width,
    height,
    minWidth: 370,
    minHeight: 370,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: false,
    center: true,
    acceptFirstMouse: true,
  });
}

/** Event a detached window listens for right after creation - see createDetachedWindow. */
export const DETACH_INIT_EVENT = "cleanotes://tab-detach-init";

export interface DetachInitPayload {
  path: string;
  content: string;
}

/** Sent directly from a window whose tab-drag resolved into a merge to the window under the
 * drop point, carrying the note's latest content - see TabStrip.tsx's finishDragOut. */
export const MERGE_TAB_EVENT = "cleanotes://tab-merge-handoff";

export type MergeTabPayload = DetachInitPayload;

/**
 * Opens a CleaNotes window for a tab that just got dragged out and dropped somewhere with no
 * matching tab strip under it, positioned at the drop point. `content` is handed to the new
 * window directly over an event rather than left for it to read off disk, so an in-flight,
 * not-yet-autosaved edit isn't lost to a race (see App.tsx's caller, which always resolves
 * this from the live editor buffer for the active tab, or a plain disk read otherwise).
 *
 * `size`, if given, skips a redundant `outerSize`/`scaleFactor` round-trip right at drop
 * time - callers dragging a tab typically already measured the source window's size once at
 * drag-start (see TabStrip.tsx), so there's no need to re-measure it again here on the
 * critical path between the user releasing the tab and the new window appearing.
 */
export async function createDetachedWindow(
  notePath: string,
  content: string,
  position: { x: number; y: number },
  size?: { width: number; height: number },
): Promise<WebviewWindow> {
  const t0 = performance.now();
  const { width, height } = size ?? (await logicalSizeOfCurrentWindow());
  console.log("[tabstrip]", `+${(performance.now() - t0).toFixed(0)}ms`, "size resolved", { width, height, measured: !size });
  const query = `${NOTE_QUERY_PARAM}=${encodeURIComponent(notePath)}&${DETACHED_QUERY_PARAM}=1`;

  const label = `note-${crypto.randomUUID()}`;
  const webview = new WebviewWindow(label, {
    url: `index.html?${query}`,
    title: "CleaNotes",
    x: position.x,
    y: position.y,
    width,
    height,
    minWidth: 370,
    minHeight: 370,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: false,
    acceptFirstMouse: true,
  });
  console.log("[tabstrip]", `+${(performance.now() - t0).toFixed(0)}ms`, "WebviewWindow constructed, waiting for tauri://created", label);

  await new Promise<void>((resolve, reject) => {
    webview.once("tauri://created", () => resolve());
    webview.once("tauri://error", (e) => reject(e.payload));
  });
  console.log("[tabstrip]", `+${(performance.now() - t0).toFixed(0)}ms`, "tauri://created fired (native window+webview exist)");

  await emitTo(label, DETACH_INIT_EVENT, { path: notePath, content } satisfies DetachInitPayload);
  console.log("[tabstrip]", `+${(performance.now() - t0).toFixed(0)}ms`, "content handed off via emitTo");

  return webview;
}

/**
 * If this window was spawned via tab-detach (`?detached=1`), starts listening for the
 * content handoff immediately at module load - before React even mounts - to minimize the
 * race against the source window's `emitTo`, which fires right after this window finishes
 * creating (see createDetachedWindow). Resolves to the handed-off content, or `null` if it
 * doesn't arrive within a few seconds (caller falls back to a plain disk read in that case).
 * `null` outside a browser/webview context (e.g. during a test import).
 */
export const detachInitPromise: Promise<string | null> | null = (() => {
  if (typeof window === "undefined") return null;
  if (new URLSearchParams(window.location.search).get(DETACHED_QUERY_PARAM) !== "1") return null;
  return new Promise<string | null>((resolve) => {
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve(null);
    }, 3000);
    // Scoped to this window's own label - `listen`/`once` default to receiving events
    // addressed to *any* window, which matters here if two windows are mid-detach at once.
    void once<DetachInitPayload>(
      DETACH_INIT_EVENT,
      (event) => {
        clearTimeout(timer);
        resolve(event.payload.content);
      },
      { target: getCurrentWindow().label },
    ).then((fn) => {
      unlisten = fn;
    });
  });
})();
