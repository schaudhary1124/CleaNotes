import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Broadcast when any window persists a note, so other windows with that note open can catch up. */
const NOTE_SAVED_EVENT = "cleanotes://note-saved";

interface NoteSavedPayload {
  path: string;
  content: string;
  sourceWindow: string;
}

/** Tells every CleaNotes window that `path` was just saved with `content`. */
export function broadcastNoteSaved(path: string, content: string): Promise<void> {
  return emit(NOTE_SAVED_EVENT, {
    path,
    content,
    sourceWindow: getCurrentWindow().label,
  } satisfies NoteSavedPayload);
}

/**
 * Notifies `handler` when a *different* window saves a note. Events emitted by this
 * same window are filtered out - callers already have that content locally.
 */
export async function listenForNoteSaved(
  handler: (path: string, content: string) => void,
): Promise<() => void> {
  const ownLabel = getCurrentWindow().label;
  return listen<NoteSavedPayload>(NOTE_SAVED_EVENT, (event) => {
    if (event.payload.sourceWindow === ownLabel) return;
    handler(event.payload.path, event.payload.content);
  });
}
