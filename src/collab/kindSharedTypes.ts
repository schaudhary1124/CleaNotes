import type * as Y from "yjs";
import { FRAGMENT_NAME } from "./sessionProtocol";
import type { NoteKind, SketchStroke } from "../types";

/**
 * Which Yjs shared types a note's kind needs on its Y.Doc, and how to get at them - the
 * kind-dispatched replacement for hostSession.ts/yjsBridge.ts each unconditionally attaching
 * the same `yXmlFragment`/`ySketchStrokes` pair to every note regardless of kind. Deliberately
 * has zero fsNotes.ts/Tauri imports (unlike kindPersistence.ts) so it's safe for the
 * browser-guest bundle - see scripts/check-browser-bundle.mjs.
 *
 * Only "default"/"fixed-size" is implemented so far; each future kind (Code, Whiteboard,
 * Spreadsheet, Calendar) adds its own shape here and its own case in attachSharedTypesForKind
 * below, following this one as the precedent.
 */
export interface KindSharedTypes {
  kind: "default" | "fixed-size";
  yXmlFragment: Y.XmlFragment;
  ySketchStrokes: Y.Array<SketchStroke>;
}

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
    case "code":
    case "whiteboard":
    case "spreadsheet":
    case "calendar":
      throw new Error(`Collaboration for "${kind}" notes isn't implemented yet.`);
  }
}
