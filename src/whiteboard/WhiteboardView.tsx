import { useMemo } from "react";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { fsAssetStore, readBoard, writeBoard, writeNote } from "../utils/fsNotes";
import { updateNoteInBacklinksIndex } from "../utils/backlinksIndex";
import { updateNoteInIndex } from "../utils/searchIndex";
import { broadcastNoteSaved } from "../utils/noteSync";
import type { HostedSession } from "../collab/hostSession";
import type { NoteKindViewProps } from "../noteKinds/DefaultKindView";
import { BoardWorkspace } from "./BoardWorkspace";
import { boardDigest } from "./boardOps";
import type { BoardElement } from "./boardTypes";
import type { BoardAssets } from "./useAssetUrl";
import { useBoardStore, type BoardFileStore, type BoardSource } from "./useBoardStore";


/** The Whiteboard kind's registered edit view (see noteKinds/registry.tsx) - the owner's own
 * board, in their own vault.
 *
 * Two things distinguish it from the guest view (SharedBoardView.tsx), and both are about being
 * the device that owns the file:
 *
 *  - It maintains the note's `.md` digest, so a board participates in search/backlinks like every
 *    other note (see boardDigest). Routed through the same activeContentRef/savedContentRef pair
 *    every other kind uses, so App.tsx's flush-on-switch/close path saves it without needing to
 *    know boards exist.
 *  - When the note is being hosted for collaborators, it hands the store the session's shared
 *    types instead of a file path, and stops writing to disk entirely - hostSession's own
 *    persistence becomes the single writer (see collab/kindPersistence.ts, which has to keep
 *    writing whether or not this view is even mounted).
 */
export function WhiteboardView({
  note,
  settings,
  activeContentRef,
  savedContentRef,
  activeCollabSession,
  toolbarVisible,
}: NoteKindViewProps) {
  const shared = whiteboardShared(activeCollabSession);

  const persistDigest = useDebouncedCallback(async (elements: BoardElement[]) => {
    // While a session is live the host's persistence writes both the sidecar and this digest, so
    // writing here too would give one file two writers - the exact thing kindPersistence.ts is
    // structured to avoid.
    if (shared) return;
    const digest = boardDigest(elements);
    activeContentRef.current = digest;
    if (digest === savedContentRef.current) return;
    await writeNote(note.path, digest);
    savedContentRef.current = digest;
    updateNoteInIndex(note.path, digest);
    updateNoteInBacklinksIndex(note.path, digest);
    await broadcastNoteSaved(note.path, digest);
  }, 900);

  // The sidecar accessor is built here, in the one file that is allowed to touch fsNotes.ts, and
  // handed to the store as data - see BoardFileStore for why the store can't import it itself.
  const file: BoardFileStore = useMemo(
    () => ({
      read: () => readBoard(note.path),
      write: (doc) => writeBoard(note.path, doc),
    }),
    [note.path],
  );

  const source: BoardSource = useMemo(
    () => (shared ? { mode: "collab", shared } : { mode: "local", file }),
    [shared, file],
  );
  const store = useBoardStore(source, persistDigest);

  const assets: BoardAssets = useMemo(
    () => ({ store: fsAssetStore, fetchRemote: activeCollabSession?.resolveAsset }),
    [activeCollabSession],
  );

  return (
    <BoardWorkspace
      store={store}
      assets={assets}
      // The owner is never read-only on their own board - the lock/viewer distinction only ever
      // applies to collaborators.
      canEdit
      toolbarVisible={toolbarVisible}
      voiceEnabled={settings.features.voiceNotes}
      codeEnabled={settings.features.codeBlock}
      voiceNoteCountdown={settings.voiceNoteCountdown}
    />
  );
}

/** Narrows a hosted session to its Whiteboard shared types, or null if this note isn't being
 * hosted (or - defensively - is being hosted as some other kind, which would mean the note's kind
 * changed underneath a running session). */
function whiteboardShared(session: HostedSession | null) {
  if (!session || session.shared.kind !== "whiteboard") return null;
  return session.shared;
}
