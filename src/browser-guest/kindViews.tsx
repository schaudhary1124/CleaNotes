import type { ComponentType } from "react";
import { BrowserEditor } from "./BrowserEditor";
import { idbAssetStore } from "./idbAssetStore";
import { SharedBoardView } from "../whiteboard/SharedBoardView";
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

/** Narrows the session's shared types (a union across every collaborative kind - see
 * kindSharedTypes.ts) to the text half before handing them to BrowserEditor.
 *
 * The narrowing lives here rather than inside BrowserEditor because *this table* is what decides
 * which component a kind gets, so this is the only place that actually knows the two agree. The
 * fallback is unreachable through the registry and exists only so the union is handled totally,
 * without a runtime assertion. */
function GuestTextView({ session, canEdit, noteId }: GuestKindViewProps) {
  if (session.shared.kind === "whiteboard") return <UnexpectedKind />;
  return <BrowserEditor session={session} shared={session.shared} canEdit={canEdit} noteId={noteId} />;
}

/** Same narrowing in the other direction, for boards. A browser guest has no filesystem, so the
 * board's images and voice notes are backed by IndexedDB, with the session as the fallback for
 * anything this device hasn't received yet - see BoardAssets. */
function GuestBoardView({ session, canEdit }: GuestKindViewProps) {
  if (session.shared.kind !== "whiteboard") return <UnexpectedKind />;
  return (
    <SharedBoardView
      session={session}
      shared={session.shared}
      canEdit={canEdit}
      assetStore={idbAssetStore}
      voiceEnabled={session.features.voiceNotes}
      codeEnabled={session.features.codeBlock}
    />
  );
}

function UnexpectedKind() {
  return (
    <div className="text-secondary flex h-full items-center justify-center p-10 text-center text-sm">
      This note's type doesn't match what the owner's device sent - try reloading.
    </div>
  );
}

/** Which component renders a note's browser-guest view, keyed by kind - the guest-side
 * counterpart of ../noteKinds/registry.tsx's NOTE_KIND_EDIT_VIEWS. A kind with no entry here
 * falls back to a "not supported here yet" message (see browser-guest/App.tsx). */
export const GUEST_KIND_VIEWS: Partial<Record<NoteKind, ComponentType<GuestKindViewProps>>> = {
  default: GuestTextView,
  "fixed-size": GuestTextView,
  whiteboard: GuestBoardView,
};
