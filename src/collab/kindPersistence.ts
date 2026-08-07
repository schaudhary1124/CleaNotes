import { prosemirrorToYXmlFragment } from "y-prosemirror";
import type { KindSharedTypes } from "./kindSharedTypes";
import { readNote, readSketch, writeSketch } from "../utils/fsNotes";
import { parseMarkdownToProseMirrorDoc } from "../milkdown/headlessParse";

/**
 * Host-only half of kind-dispatched collab persistence: seeding a freshly-attached
 * KindSharedTypes from disk when a session starts, and mirroring live changes back to disk
 * while it runs. Kept separate from kindSharedTypes.ts specifically because this file needs
 * fsNotes.ts's `@tauri-apps/plugin-fs` calls and milkdown/headlessParse.ts's full desktop
 * Milkdown plugin set - per hostSession.ts's own module comment on why that split exists, this
 * file must only ever be imported by hostSession.ts, never by yjsBridge.ts.
 */

/** Seeds a freshly attached (empty) KindSharedTypes with the note's current on-disk content -
 * must run before `shared` is exposed to any sync machinery. See hostSession.ts's original
 * inline version of this for the full story of the data-loss bug this ordering prevents. */
export async function seedSharedTypesFromDisk(notePath: string, shared: KindSharedTypes): Promise<void> {
  switch (shared.kind) {
    case "default":
    case "fixed-size": {
      const onDiskContent = await readNote(notePath);
      if (onDiskContent.length > 0) {
        const doc = await parseMarkdownToProseMirrorDoc(onDiskContent, notePath);
        prosemirrorToYXmlFragment(doc, shared.yXmlFragment);
      }
      const onDiskSketch = await readSketch(notePath);
      if (onDiskSketch && onDiskSketch.strokes.length > 0) shared.ySketchStrokes.push(onDiskSketch.strokes);
      return;
    }
  }
}

/** A running kind's disk-persistence hooks - stop them (flushing any pending debounced write
 * first) when the hosting session ends. */
export interface KindPersistenceHandle {
  /** Immediately writes out any pending debounced change - call during session teardown so a
   * change made just before close isn't lost to an in-flight debounce timer. */
  flush(): Promise<void>;
  /** Cancels any pending debounced write without flushing it - call once `flush` has already
   * run, so a stray timer can't fire after teardown. */
  dispose(): void;
}

/** Wires up disk persistence for a freshly attached KindSharedTypes: observes live changes and
 * mirrors them back to the note's sidecar/`.md` file, debounced the same way sketch autosave
 * always has been. Kinds without an always-open editor to piggyback autosave on (i.e. every
 * kind except Default/Fixed-Size, once implemented) MUST get their own case here rather than
 * relying on the yXmlFragment pattern, which only persists while the owner has the note open -
 * see this module's own header comment and hostSession.ts's module comment for why. */
export function wireSharedTypePersistence(notePath: string, shared: KindSharedTypes): KindPersistenceHandle {
  switch (shared.kind) {
    case "default":
    case "fixed-size": {
      const { ySketchStrokes } = shared;
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const writeNow = () => void writeSketch(notePath, { version: 1, strokes: ySketchStrokes.toArray() });
      ySketchStrokes.observe(() => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveTimer = null;
          writeNow();
        }, 500);
      });
      return {
        flush: async () => {
          if (!saveTimer) return;
          clearTimeout(saveTimer);
          saveTimer = null;
          writeNow();
        },
        dispose: () => {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = null;
        },
      };
    }
  }
}
