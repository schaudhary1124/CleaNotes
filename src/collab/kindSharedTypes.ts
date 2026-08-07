import type * as Y from "yjs";
import { FRAGMENT_NAME } from "./sessionProtocol";
import type { BoardElement } from "../whiteboard/boardTypes";
import type { NoteKind, SketchStroke } from "../types";

/**
 * Which Yjs shared types a note's kind needs on its Y.Doc, and how to get at them - the
 * kind-dispatched replacement for hostSession.ts/yjsBridge.ts each unconditionally attaching
 * the same `yXmlFragment`/`ySketchStrokes` pair to every note regardless of kind. Deliberately
 * has zero fsNotes.ts/Tauri imports (unlike kindPersistence.ts) so it's safe for the
 * browser-guest bundle - see scripts/check-browser-bundle.mjs. `../whiteboard/boardTypes` is
 * likewise import-free and safe here for the same reason.
 *
 * Default/Fixed-Size and Whiteboard are implemented; each remaining kind (Code, Spreadsheet,
 * Calendar) adds its own shape here and its own case in attachSharedTypesForKind below.
 */

/** Default/Fixed-Size: a ProseMirror-backed document plus its ink overlay. */
export interface TextKindShared {
  kind: "default" | "fixed-size";
  yXmlFragment: Y.XmlFragment;
  ySketchStrokes: Y.Array<SketchStroke>;
}

/**
 * Whiteboard: an id-keyed map of elements, an explicit z-order, and a small metadata map.
 *
 * Deliberately NOT one Y.Array of elements the way ySketchStrokes is. Ink strokes are only ever
 * appended or cleared, so an array whose non-append case rewrites wholesale (see sketchSync.ts)
 * costs nothing in practice. Board elements are *dragged*: the common concurrent case is two
 * people moving two different elements at the same time, which under a wholesale array rewrite
 * would have each peer's in-flight rewrite clobber the other's move. Keying by id makes that case
 * conflict-free - each element is its own last-writer-wins register, so concurrent edits only
 * contend when they target the same element.
 *
 * Splitting z-order into its own array is the price of that: with an id-keyed map there is no
 * positional order left to read paint order from. It's a small array of strings, rewritten only
 * on an actual reorder (bring to front / send to back), never on a move.
 */
export interface WhiteboardKindShared {
  kind: "whiteboard";
  /** Element id -> element. Values are plain JSON-compatible objects, exactly like the
   * SketchStroke objects already stored in ySketchStrokes. */
  yElements: Y.Map<BoardElement>;
  /** Element ids, back-to-front. Ids here with no matching `yElements` entry (and vice versa) are
   * tolerated rather than treated as corruption - the two maps are updated in one transaction,
   * but a peer can still observe an intermediate state, and a board must never fail to render
   * because of one. See boardSync.ts's readBoardElements. */
  yOrder: Y.Array<string>;
  /** Board-level settings that aren't elements - currently just `surface` (see BoardSurface).
   * The camera (BoardViewport) deliberately does NOT live here: each person navigates an infinite
   * canvas independently, and syncing it would drag every collaborator's view around. */
  yMeta: Y.Map<unknown>;
}

export type KindSharedTypes = TextKindShared | WhiteboardKindShared;

/** Attaches (or re-resolves, if already attached - Yjs shared-type lookups are idempotent by
 * name) the Yjs shared type(s) a note's kind needs onto `ydoc`. Must be called - on both the
 * host and guest side - before anything reads/writes through the returned shared types, but
 * does NOT require the Y.Doc to already hold the note's content (see kindPersistence.ts for
 * seeding on the host side; a guest instead catches up via the "welcome" snapshot). */
export function attachSharedTypesForKind(ydoc: Y.Doc, kind: NoteKind): KindSharedTypes {
  switch (kind) {
    case "default":
    case "fixed-size":
      return {
        kind,
        yXmlFragment: ydoc.getXmlFragment(FRAGMENT_NAME),
        ySketchStrokes: ydoc.getArray<SketchStroke>("sketch"),
      };
    case "whiteboard":
      return {
        kind,
        yElements: ydoc.getMap<BoardElement>("board-elements"),
        yOrder: ydoc.getArray<string>("board-order"),
        yMeta: ydoc.getMap<unknown>("board-meta"),
      };
    case "code":
    case "spreadsheet":
    case "calendar":
      throw new Error(`Collaboration for "${kind}" notes isn't implemented yet.`);
  }
}
