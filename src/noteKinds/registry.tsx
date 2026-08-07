import type { ComponentType } from "react";
import { DefaultKindView, type NoteKindViewProps } from "./DefaultKindView";
import { WhiteboardView } from "../whiteboard/WhiteboardView";
import type { NoteKind } from "../types";

/** Which component renders a note's edit view, keyed by kind - the extension point each future
 * template phase adds one entry to, instead of App.tsx's render branch growing a new conditional
 * every time. A kind with no entry here falls back to an "unsupported" notice (see App.tsx). */
export const NOTE_KIND_EDIT_VIEWS: Partial<Record<NoteKind, ComponentType<NoteKindViewProps>>> = {
  default: DefaultKindView,
  // Fixed-Size reuses the same Editor-backed component: pagination is a runtime prop
  // (Editor.tsx's `pagination`), not a forked view - see DefaultKindView's own comment.
  "fixed-size": DefaultKindView,
  // Whiteboard is the first kind that is *not* Milkdown-backed: its document lives in a
  // `.whiteboard.json` sidecar and the note's own Markdown is a derived text digest (see
  // whiteboard/boardOps.ts's boardDigest). It still takes the same NoteKindViewProps bag, so
  // App.tsx needs no knowledge of any of that.
  whiteboard: WhiteboardView,
};

export type { NoteKindViewProps };
