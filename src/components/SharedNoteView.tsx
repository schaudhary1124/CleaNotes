import type { JoinedSession } from "../collab/yjsBridge";
import { usePresence } from "../collab/usePresence";
import { fsAssetStore } from "../utils/fsNotes";
import { SharedBoardView } from "../whiteboard/SharedBoardView";
import type { GuestJoinedNote } from "../types";
import { Editor } from "./Editor";

interface SharedNoteViewProps {
  /** Null only for an instant while the sidebar's guest-notes list is still catching up right
   * after navigating here - the connection effect in App.tsx is what actually drives `session`. */
  note: GuestJoinedNote | null;
  session: JoinedSession | null;
  status: "connecting" | "connected" | "offline";
  /** Tracked separately from session.canEdit (only a connect-time snapshot) so the owner
   * changing this device's role, or toggling the note's lock, while connected can flip the
   * editor read-only live - see App.tsx's onCanEditChanged wiring. */
  canEdit: boolean;
  onBack: () => void;
}

function noop() {}
async function noopAsync() {}

/**
 * Guest-side live view of a shared note, reached from the sidebar's Shared Notes section rather
 * than a modal - see App.tsx's "shared" view branch. Reuses the same <Editor> the owner's own
 * vault notes use (so the ProseMirror schema - and therefore what Yjs can represent - is
 * identical on both sides), with a synthetic notePath and every vault-dependent feature
 * (sketches, voice notes, note links, saving to disk at all) disabled: a guest never has a local
 * vault entry for someone else's note, and per the collab plan's structural-isolation principle
 * should never be able to browse or affect anything beyond this one note anyway.
 */
export function SharedNoteView({ note, session, status, canEdit, onBack }: SharedNoteViewProps) {
  const presence = usePresence(session?.awareness);
  const title = note?.title ?? "Shared note";

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex shrink-0 items-center justify-between px-2">
        <div className="min-w-0">
          <p className="text-primary truncate text-sm font-semibold">{title}</p>
          <p className="text-secondary text-xs">
            {status === "connected" && session ? (
              <>Live shared note · <span className="font-medium">{canEdit ? "editing" : "viewing"}</span></>
            ) : status === "connecting" ? (
              "Connecting…"
            ) : (
              "Owner is offline - reconnects automatically once they're back."
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {presence.length > 0 && (
            <div className="flex items-center gap-1" title={presence.map((p) => p.name).join(", ")}>
              {presence.slice(0, 4).map((p) => (
                <div
                  key={p.clientId}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                  style={{ backgroundColor: p.color }}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={onBack} className="btn-ghost h-7 rounded-lg px-3 text-xs">
            Back
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl">
        {session && session.shared.kind === "whiteboard" ? (
          <SharedBoardView
            // Same generation keying as the Editor branch below, for the same reason.
            key={`${canEdit}:${session.generation}`}
            session={session}
            shared={session.shared}
            canEdit={canEdit}
            // A desktop guest does have a filesystem, so board images/voice notes land in this
            // device's own content-addressed store - the same one its vault notes use.
            assetStore={fsAssetStore}
            voiceEnabled={session.features.voiceNotes}
            codeEnabled={session.features.codeBlock}
          />
        ) : session && session.shared.kind !== "whiteboard" ? (
          <Editor
            // Includes session.generation so a resync (owner restarted hosting without this
            // guest connection ever dropping - see yjsBridge.ts's JoinedSession.generation)
            // remounts the editor bound to the fresh yXmlFragment/awareness below, instead of an
            // already-mounted instance silently going stale against objects that no longer
            // receive updates.
            key={`${canEdit}:${session.generation}`}
            notePath={`__shared__/${note?.noteId ?? "unknown"}.md`}
            initialContent=""
            onChange={noop}
            onSave={noopAsync}
            toolbarVisible
            sketchMode={false}
            onToggleSketchMode={noop}
            sketchEnabled={false}
            codeBlockEnabled={session.features.codeBlock}
            voiceNotesEnabled={false}
            voiceNoteCountdown={0}
            paginated={session.kind === "fixed-size"}
            noteChoices={[]}
            onNavigateToNoteLink={noop}
            collabSession={{
              yXmlFragment: session.shared.yXmlFragment,
              canEdit,
              awareness: session.awareness,
              ySketchStrokes: session.shared.ySketchStrokes,
              resolveAsset: session.resolveAsset,
            }}
          />
        ) : (
          <div className="text-secondary flex h-full items-center justify-center text-sm">
            {status === "offline"
              ? "Waiting for the owner's device to come back online…"
              : "Connecting to the shared note…"}
          </div>
        )}
      </div>
    </div>
  );
}
