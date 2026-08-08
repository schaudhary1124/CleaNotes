import { useMemo } from "react";
import type { AssetStore } from "../collab/assetStore";
import type { WhiteboardKindShared } from "../collab/kindSharedTypes";
import type { JoinedSession } from "../collab/yjsBridge";
import { BoardWorkspace } from "./BoardWorkspace";
import type { BoardAssets } from "./useAssetUrl";
import { useBoardStore, type BoardSource } from "./useBoardStore";

/**
 * A collaborator's view of someone else's board - the guest counterpart of WhiteboardView.
 *
 * Used by *both* guest surfaces: the desktop app's Shared Notes view (components/SharedNoteView)
 * and the browser-guest build (browser-guest/kindViews). The only thing that differs between them
 * is where binary assets live - the desktop guest has a real filesystem, a browser guest has
 * IndexedDB - so that arrives as an injected `assetStore` rather than being imported, which is
 * also what keeps this file free of any Tauri dependency (see scripts/check-browser-bundle.mjs).
 *
 * There is no `notePath` and no disk write anywhere in this path: a guest has no vault entry for
 * someone else's note, and the owner's device is the durable home for the board (see
 * collab/kindPersistence.ts). Edits made here travel as CRDT updates and become a file only on
 * the owner's side.
 */
export function SharedBoardView({
  session,
  shared,
  canEdit,
  assetStore,
  prepareImage,
  voiceEnabled,
  codeEnabled,
}: {
  session: JoinedSession;
  /** Already narrowed off `session.shared` by whichever registry routed here - see
   * browser-guest/kindViews.tsx for why the narrowing lives there. */
  shared: WhiteboardKindShared;
  canEdit: boolean;
  assetStore: AssetStore;
  /** See BoardAssets.prepareImage - injected alongside `assetStore` for the same reason, and by
   * the same two call sites. */
  prepareImage?: (file: File) => Promise<Uint8Array>;
  /** The *owner's* feature flags as of connect time (see JoinedSession.features) - a guest
   * shouldn't be offered a widget the owner has turned off on their own device. */
  voiceEnabled: boolean;
  codeEnabled: boolean;
}) {
  const source: BoardSource = useMemo(() => ({ mode: "collab", shared }), [shared]);
  const store = useBoardStore(source);

  const assets: BoardAssets = useMemo(
    // A guest legitimately starts with none of the owner's images, so the peer fetch isn't an
    // error path here - it's how assets normally arrive the first time.
    () => ({ store: assetStore, fetchRemote: session.resolveAsset, prepareImage }),
    [assetStore, session, prepareImage],
  );

  return (
    <BoardWorkspace
      store={store}
      assets={assets}
      canEdit={canEdit}
      toolbarVisible
      voiceEnabled={voiceEnabled}
      codeEnabled={codeEnabled}
      // A guest has no access to the owner's app settings, and the countdown is a recording-time
      // nicety rather than shared document state - start capturing immediately.
      voiceNoteCountdown={0}
    />
  );
}
