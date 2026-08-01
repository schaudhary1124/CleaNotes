import { useEffect, useRef, useState } from "react";
import { loadOrCreateIdentity } from "../collab/identity";
import { InviteError, parseInvite } from "../collab/invite";
import { redeemInvite } from "../collab/signaling";
import { joinSession, type JoinedSession } from "../collab/yjsBridge";
import { usePresence } from "../collab/usePresence";
import { Editor } from "./Editor";

interface JoinSharedNoteDialogProps {
  onClose: () => void;
}

const DISPLAY_NAME_STORAGE_KEY = "cleanotes:collab:display-name";

type Phase =
  | { kind: "idle" }
  | { kind: "redeeming" }
  | { kind: "connecting" }
  | { kind: "connected"; session: JoinedSession; noteId: string }
  | { kind: "ended"; reason: "revoked" | "closing" }
  | { kind: "failed"; message: string };

function noop() {}
async function noopAsync() {}

/**
 * Guest-side entry point for redeeming an invite someone else sent you, then live-editing the
 * shared note. Reuses the same <Editor> the owner's own vault notes use (so the ProseMirror
 * schema - and therefore what Yjs can represent - is identical on both sides), but with a
 * synthetic notePath and every vault-dependent feature (sketches, voice notes, note links, and
 * saving to disk at all) disabled: a guest never has a local vault entry for someone else's
 * note, and per the collab plan's structural-isolation principle should never be able to browse
 * or affect anything beyond this one note anyway.
 */
export function JoinSharedNoteDialog({ onClose }: JoinSharedNoteDialogProps) {
  const [inviteText, setInviteText] = useState("");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Tracked separately from the connect-time snapshot on JoinedSession itself so the owner
  // changing this device's role (or toggling the lock) while connected can actually flip the
  // editor read-only live - see onCanEditChanged below and the Editor `key` that forces a
  // remount when this changes, same pattern App.tsx uses on the owner's side.
  const [liveCanEdit, setLiveCanEdit] = useState(true);
  const sessionRef = useRef<JoinedSession | null>(null);

  useEffect(() => {
    localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName);
  }, [displayName]);

  // Closes the live session (if any) whenever this dialog goes away, regardless of which
  // button/backdrop-click path triggered it - simpler and more robust than intercepting every
  // individual close handler below.
  useEffect(() => {
    return () => {
      sessionRef.current?.close();
    };
  }, []);

  async function handleJoin() {
    let invite;
    try {
      invite = parseInvite(inviteText);
    } catch (err) {
      setPhase({ kind: "failed", message: err instanceof InviteError ? err.message : "Couldn't read that invite." });
      return;
    }
    if (!displayName.trim()) {
      setPhase({ kind: "failed", message: "Enter a name so the owner knows who's asking." });
      return;
    }

    setPhase({ kind: "redeeming" });
    const identity = await loadOrCreateIdentity();
    const result = await redeemInvite(invite, identity, displayName.trim());

    if (result.status === "timeout") {
      setPhase({
        kind: "failed",
        message: "Couldn't reach the owner's device. Make sure they still have the invite open, then try again.",
      });
      return;
    }
    if (result.status === "denied") {
      setPhase({ kind: "failed", message: result.reason ?? "That invite was declined." });
      return;
    }

    setPhase({ kind: "connecting" });
    try {
      const session = await joinSession(invite.noteId, invite.ownerPubKey, invite.role, identity, displayName.trim(), {
        onCanEditChanged: setLiveCanEdit,
        onEnded: (reason: "revoked" | "closing") => {
          sessionRef.current = null;
          setPhase({ kind: "ended", reason });
        },
      });
      sessionRef.current = session;
      setLiveCanEdit(session.canEdit);
      setPhase({ kind: "connected", session, noteId: invite.noteId });
    } catch (err) {
      setPhase({ kind: "failed", message: err instanceof Error ? err.message : "Couldn't connect to the shared note." });
    }
  }

  const connected = phase.kind === "connected";
  const presence = usePresence(phase.kind === "connected" ? phase.session.awareness : undefined);

  return (
    <div
      className="animate-fade-in absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !connected) onClose();
      }}
    >
      <div
        className={`glass-surface shadow-app-lg flex w-full flex-col rounded-2xl @max-sm:p-4 ${
          connected ? "h-full max-w-4xl p-3" : "max-w-sm p-5"
        }`}
      >
        {connected ? (
          <>
            <div className="mb-2 flex shrink-0 items-center justify-between px-2">
              <p className="text-secondary text-xs">
                Live shared note · <span className="font-medium">{liveCanEdit ? "editing" : "viewing"}</span>
              </p>
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
                <button type="button" onClick={onClose} className="btn-ghost h-7 rounded-lg px-3 text-xs">
                  Leave
                </button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl">
              <Editor
                key={`${phase.noteId}:${liveCanEdit}`}
                notePath={`__shared__/${phase.noteId}.md`}
                initialContent=""
                onChange={noop}
                onSave={noopAsync}
                toolbarVisible
                sketchMode={false}
                onToggleSketchMode={noop}
                sketchEnabled={false}
                codeBlockEnabled
                voiceNotesEnabled={false}
                noteChoices={[]}
                onNavigateToNoteLink={noop}
                collabSession={{ yXmlFragment: phase.session.yXmlFragment, canEdit: liveCanEdit, awareness: phase.session.awareness }}
              />
            </div>
          </>
        ) : phase.kind === "ended" ? (
          <>
            <p className="text-primary text-base font-semibold">
              {phase.reason === "revoked" ? "Access removed" : "Owner disconnected"}
            </p>
            <p className="text-secondary mt-1.5 text-sm leading-relaxed">
              {phase.reason === "revoked"
                ? "The owner removed your access to this note."
                : "The owner closed this note, so live editing has stopped. You're still a collaborator on it, but reconnecting needs a fresh invite link from them for now - ask them to open the note and send you a new one."}
            </p>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={onClose} className="btn-ghost h-9 rounded-lg px-4 text-sm">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-primary text-base font-semibold">Join a shared note</p>
            <p className="text-secondary mt-1.5 text-sm leading-relaxed">
              Paste the invite link someone sent you, along with your name so they know who's asking.
            </p>

            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="border-subtle bg-surface-hover text-primary mt-4 h-9 w-full rounded-lg border px-3 text-sm focus:outline-none"
            />
            <textarea
              value={inviteText}
              onChange={(e) => setInviteText(e.target.value)}
              placeholder="cleanotes-invite://..."
              rows={3}
              className="border-subtle bg-surface-hover text-primary mt-2 w-full resize-none rounded-lg border px-3 py-2 text-xs focus:outline-none"
            />

            {phase.kind === "failed" && <p className="mt-2 text-xs text-red-500">{phase.message}</p>}
            {phase.kind === "redeeming" && <p className="text-tertiary mt-2 text-xs">Connecting…</p>}
            {phase.kind === "connecting" && <p className="text-tertiary mt-2 text-xs">Loading the shared note…</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-ghost h-9 rounded-lg px-4 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleJoin()}
                disabled={phase.kind === "redeeming" || phase.kind === "connecting" || !inviteText.trim()}
                className="bg-accent-solid h-9 rounded-lg px-4 text-sm font-medium text-white transition-colors duration-150 hover:brightness-110 disabled:opacity-50"
              >
                Join
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
