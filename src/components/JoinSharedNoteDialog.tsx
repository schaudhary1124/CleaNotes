import { useState } from "react";
import { knownPublicKeyHex } from "../collab/identity";
import { InviteError, parseInvite } from "../collab/invite";
import { makePendingGuestNote, upsertGuestNote } from "../collab/sharedNotesStore";

interface JoinSharedNoteDialogProps {
  onClose: () => void;
  /** Wakes up App.tsx's guest-invite supervisor immediately after a link is submitted, instead
   * of waiting for its next poll - see App.tsx's refreshGuestNotes. */
  onSubmitted: () => void;
}

const DISPLAY_NAME_STORAGE_KEY = "cleanotes:collab:display-name";

/**
 * Guest-side entry point for redeeming an invite someone else sent you. Only responsible for
 * parsing the pasted link and recording the join request - it closes immediately after, rather
 * than sitting on "Connecting…" until the owner responds (which could now be up to 24h later).
 * The actual redemption, and the live-editing view once granted, both live at the App level from
 * here on - see App.tsx's guest-invite supervisor and the "shared" view / sidebar Shared Notes
 * section, which is where this request shows up next as "pending".
 */
export function JoinSharedNoteDialog({ onClose, onSubmitted }: JoinSharedNoteDialogProps) {
  const [inviteText, setInviteText] = useState("");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) ?? "");
  const [error, setError] = useState<string | null>(null);

  function handleJoin() {
    let invite;
    try {
      invite = parseInvite(inviteText);
    } catch (err) {
      setError(err instanceof InviteError ? err.message : "Couldn't read that invite.");
      return;
    }
    if (invite.ownerPubKey === knownPublicKeyHex()) {
      setError("That's your own invite link - open Share on the note instead of joining it.");
      return;
    }
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError("Enter a name so the owner knows who's asking.");
      return;
    }

    localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, trimmedName);
    upsertGuestNote(
      makePendingGuestNote({
        noteId: invite.noteId,
        ownerPubKey: invite.ownerPubKey,
        role: invite.role,
        secret: invite.secret,
        displayName: trimmedName,
        expiresAt: invite.expiresAt,
      }),
    );
    onSubmitted();
    onClose();
  }

  return (
    <div
      className="animate-fade-in absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-surface shadow-app-lg flex w-full max-w-sm flex-col rounded-2xl p-5 @max-sm:p-4">
        <p className="text-primary text-base font-semibold">Join a shared note</p>
        <p className="text-secondary mt-1.5 text-sm leading-relaxed">
          Paste the invite link someone sent you, along with your name so they know who's asking. It'll show up
          in your Shared Notes as soon as they approve it - even if that's not right away.
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

        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost h-9 rounded-lg px-4 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleJoin}
            disabled={!inviteText.trim()}
            className="bg-accent-solid h-9 rounded-lg px-4 text-sm font-medium text-white transition-colors duration-150 hover:brightness-110 disabled:opacity-50"
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}
