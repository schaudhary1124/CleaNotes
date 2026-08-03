import type { Array as YArray } from "yjs";
import type { SketchStroke } from "../types";

/**
 * Shared by Editor.tsx (desktop) and BrowserEditor.tsx (browser guest) - both mirror their local
 * Sketch-mode `strokes` state into a collab session's shared array (see hostSession.ts's/
 * yjsBridge.ts's ySketchStrokes) the same way, so this lives here instead of being duplicated.
 */

/** Distinguishes this device's own edits to a session's ySketchStrokes (already reflected in
 * local `strokes` state directly by whatever called applyStrokesToYArray) from a peer's, inside
 * a Y.Array observer - without it, applying our own change would immediately bounce back into a
 * redundant local state update. */
export const SKETCH_LOCAL_ORIGIN = Symbol("sketch-local-edit");

/** Mirrors `next` into a session's shared sketch array in one Yjs transaction. The common case -
 * a normal draw gesture, where `next` is the previous strokes plus exactly one new stroke at the
 * end - pushes just that stroke, an O(1) CRDT insert; anything else (erase, clear, undo/redo
 * landing on an arbitrary snapshot) replaces the array wholesale, the same "whole-document"
 * persistence model the desktop-only local disk fallback (writeSketch) already uses. */
export function applyStrokesToYArray(yArr: YArray<SketchStroke>, next: SketchStroke[]) {
  const ydoc = yArr.doc;
  if (!ydoc) return;
  ydoc.transact(() => {
    const prevLength = yArr.length;
    const isAppend =
      next.length === prevLength + 1 && Array.from({ length: prevLength }, (_, i) => i).every((i) => yArr.get(i).id === next[i].id);
    if (isAppend) {
      yArr.push([next[next.length - 1]]);
      return;
    }
    yArr.delete(0, prevLength);
    if (next.length > 0) yArr.insert(0, next);
  }, SKETCH_LOCAL_ORIGIN);
}
