import type { WhiteboardKindShared } from "./kindSharedTypes";
import type { BoardElement, BoardSurface } from "../whiteboard/boardTypes";

/**
 * Read/write bridge between a board's flat `BoardElement[]` and the Yjs shared types backing a
 * live session - the Whiteboard counterpart of sketchSync.ts, and shared by every side that
 * touches a board (owner, desktop guest, browser guest) so the mapping can't drift between them.
 *
 * Kept free of any Tauri/fsNotes import so the browser-guest bundle can use it - see
 * scripts/check-browser-bundle.mjs.
 */

/** Marks a transaction as originating from this device, so an observer can skip re-reading state
 * it already applied locally. Same role as sketchSync.ts's SKETCH_LOCAL_ORIGIN. */
export const BOARD_LOCAL_ORIGIN = Symbol("board-local-edit");

/** Rebuilds the ordered element list from the shared types.
 *
 * `yOrder` is the authority on paint order, but the two shared types are read independently and a
 * peer can legitimately observe a moment where they disagree (an element inserted into one but not
 * yet the other). Rather than treating that as corruption, ids in `yOrder` with no element are
 * skipped and elements missing from `yOrder` are appended - so a board always renders everything
 * it actually has, and a transient mid-transaction read just shows a briefly odd z-order rather
 * than dropping someone's work off the canvas. */
export function readBoardElements(shared: WhiteboardKindShared): BoardElement[] {
  const { yElements, yOrder } = shared;
  const result: BoardElement[] = [];
  const placed = new Set<string>();
  for (const id of yOrder.toArray()) {
    if (placed.has(id)) continue; // defensive: a duplicated id would otherwise render twice
    const element = yElements.get(id);
    if (!element) continue;
    placed.add(id);
    result.push(element);
  }
  for (const [id, element] of yElements.entries()) {
    if (!placed.has(id)) result.push(element);
  }
  return result;
}

export function readBoardSurface(shared: WhiteboardKindShared): BoardSurface {
  const value = shared.yMeta.get("surface");
  return value === "graph" || value === "isometric" ? value : "plain";
}

export function writeBoardSurface(shared: WhiteboardKindShared, surface: BoardSurface): void {
  shared.yMeta.doc?.transact(() => shared.yMeta.set("surface", surface), BOARD_LOCAL_ORIGIN);
}

/**
 * Mirrors `next` into the shared types in one transaction, writing only what actually changed.
 *
 * `mirrored` is what this device last wrote to (or last read from) the shared types, keyed by id.
 * Changed elements are detected by *reference*, not by deep comparison: every board mutation is an
 * immutable rebuild that reuses the objects it didn't touch (see boardOps.ts), so a pointer
 * comparison is both exact and O(1) per element. Deep-comparing instead would mean walking every
 * ink stroke's full point list on every frame of a drag, for no additional accuracy.
 *
 * Returns the new mirror, which the caller must hold onto for the next call.
 */
export function writeBoardElements(
  shared: WhiteboardKindShared,
  next: readonly BoardElement[],
  mirrored: ReadonlyMap<string, BoardElement>,
): Map<string, BoardElement> {
  const { yElements, yOrder } = shared;
  const ydoc = yElements.doc;
  const nextMirror = new Map<string, BoardElement>();
  for (const element of next) nextMirror.set(element.id, element);
  if (!ydoc) return nextMirror;

  ydoc.transact(() => {
    for (const element of next) {
      if (mirrored.get(element.id) !== element) yElements.set(element.id, element);
    }
    for (const id of mirrored.keys()) {
      if (!nextMirror.has(id)) yElements.delete(id);
    }

    // Order is rewritten only when the id sequence genuinely differs - a plain move/resize leaves
    // it untouched, so the common case costs one comparison rather than a CRDT array rewrite.
    const currentOrder = yOrder.toArray();
    const nextOrder = next.map((element) => element.id);
    if (!sameOrder(currentOrder, nextOrder)) {
      yOrder.delete(0, yOrder.length);
      if (nextOrder.length > 0) yOrder.insert(0, nextOrder);
    }
  }, BOARD_LOCAL_ORIGIN);

  return nextMirror;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Seeds empty shared types from an existing element list - the host's "import what's on disk"
 * path (see kindPersistence.ts). Writes through the same transaction shape as a normal edit so
 * there is only one code path that ever populates these types. */
export function seedBoardElements(shared: WhiteboardKindShared, elements: readonly BoardElement[]): void {
  writeBoardElements(shared, elements, new Map());
}
