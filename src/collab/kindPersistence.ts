import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { readBoardElements, readBoardSurface, seedBoardElements, writeBoardSurface } from "./boardSync";
import type { KindSharedTypes } from "./kindSharedTypes";
import { readBoard, readNote, readSketch, writeBoard, writeNote, writeSketch } from "../utils/fsNotes";
import { parseMarkdownToProseMirrorDoc } from "../milkdown/headlessParse";
import { updateNoteInBacklinksIndex } from "../utils/backlinksIndex";
import { updateNoteInIndex } from "../utils/searchIndex";
import { boardDigest } from "../whiteboard/boardOps";
import { emptyBoard } from "../whiteboard/boardTypes";

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
    case "whiteboard": {
      const board = (await readBoard(notePath)) ?? emptyBoard();
      writeBoardSurface(shared, board.surface);
      if (board.elements.length > 0) seedBoardElements(shared, board.elements);
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

const SAVE_DEBOUNCE_MS = 500;

/** Small helper so each kind below gets the same debounce/flush/dispose semantics rather than
 * three hand-rolled copies of the same timer dance. */
function debouncedWriter(write: () => void | Promise<void>): KindPersistenceHandle & { schedule(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void write();
      }, SAVE_DEBOUNCE_MS);
    },
    flush: async () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      await write();
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Wires up disk persistence for a freshly attached KindSharedTypes: observes live changes and
 * mirrors them back to the note's sidecar/`.md` file, debounced the same way sketch autosave
 * always has been. Kinds without an always-open editor to piggyback autosave on (i.e. every
 * kind except Default/Fixed-Size) MUST get their own case here rather than relying on the
 * yXmlFragment pattern, which only persists while the owner has the note open - see this
 * module's own header comment and hostSession.ts's module comment for why. */
export function wireSharedTypePersistence(notePath: string, shared: KindSharedTypes): KindPersistenceHandle {
  switch (shared.kind) {
    case "default":
    case "fixed-size": {
      const { ySketchStrokes } = shared;
      const writer = debouncedWriter(() =>
        writeSketch(notePath, { version: 1, strokes: ySketchStrokes.toArray() }),
      );
      ySketchStrokes.observe(() => writer.schedule());
      return writer;
    }
    case "whiteboard": {
      // A Whiteboard is the case this file's header warning was written for: hostSession runs for
      // every shared note whether or not the owner has it open (see App.tsx's
      // reconcileHostedSessions), so while a session is live this is frequently the *only* writer
      // for the board - a guest can be reshaping a board the owner isn't even looking at. That
      // also makes it the sole writer when the owner *does* have it open: WhiteboardView stops
      // persisting for the duration of a session precisely so there is exactly one writer, the
      // same rule Editor.tsx's sketch autosave already follows.
      const writer = debouncedWriter(async () => {
        const elements = readBoardElements(shared);
        // The camera is not part of the shared document (see WhiteboardKindShared), so whatever
        // viewport is already on disk is carried across rather than being reset to the origin -
        // the owner reopening the board afterwards lands where they left it. Re-read per write
        // rather than captured once at wire-up time: capturing would race the first save against
        // its own async read, and a read per debounced save is negligible next to the write.
        const existing = await readBoard(notePath);
        await writeBoard(notePath, {
          version: 1,
          surface: readBoardSurface(shared),
          elements,
          viewport: existing?.viewport ?? emptyBoard().viewport,
        });
        // The `.md` digest has to be rewritten here too, for the same "owner may not have it
        // open" reason - otherwise a guest's edits would leave the note's searchable text frozen
        // at whatever it was when the owner last had the board open. See boardDigest.
        const digest = boardDigest(elements);
        await writeNote(notePath, digest);
        updateNoteInIndex(notePath, digest);
        updateNoteInBacklinksIndex(notePath, digest);
      });

      shared.yElements.observe(() => writer.schedule());
      shared.yOrder.observe(() => writer.schedule());
      shared.yMeta.observe(() => writer.schedule());
      return writer;
    }
  }
}
