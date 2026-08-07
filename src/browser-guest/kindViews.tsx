import type { ComponentType } from "react";
import { BrowserEditor } from "./BrowserEditor";
import type { JoinedSession } from "../collab/yjsBridge";
import type { NoteKind } from "../types";

/** Prop bag every registered guest view component takes - matches BrowserEditor's own props
 * structurally, kept as a separate type here (rather than exporting BrowserEditor's) so this
 * registry's shape doesn't depend on one specific view's internals. */
export interface GuestKindViewProps {
  session: JoinedSession;
  canEdit: boolean;
  noteId: string;
}

/** Which component renders a note's browser-guest view, keyed by kind - the guest-side
 * counterpart of ../noteKinds/registry.tsx's NOTE_KIND_EDIT_VIEWS. A kind with no entry here
 * falls back to a "not supported here yet" message (see browser-guest/App.tsx). */
export const GUEST_KIND_VIEWS: Partial<Record<NoteKind, ComponentType<GuestKindViewProps>>> = {
  default: BrowserEditor,
  "fixed-size": BrowserEditor,
};
