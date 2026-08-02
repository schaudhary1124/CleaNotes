import { AlertTriangle, Clock, FileText, Pencil, Eye, RotateCw, UserPlus, WifiOff, X } from "lucide-react";
import type { SharedNoteSummary } from "../collab/acl";
import type { GuestJoinedNote } from "../types";

type GuestRequestPhase = "connecting" | "acknowledged" | "stalled";

interface SharedNotesListProps {
  /** Notes this device owns that have ever been shared (may have zero *active* collaborators
   * right now, e.g. an invite was created but never redeemed, or everyone was revoked - still
   * shown so the owner can re-invite, with onUnshareOwned as the way to clear it out instead). */
  ownedSharedNotes: SharedNoteSummary[];
  /** Notes this device is a guest on, across every status - see sharedNotesStore.ts. */
  guestNotes: GuestJoinedNote[];
  /** Live status of each "pending" guest note's current redemption attempt, keyed by noteId -
   * see App.tsx's guestRequestPhases. Absent entries (including for non-pending notes) render
   * as the initial "Connecting…" state. */
  requestPhases: Record<string, GuestRequestPhase>;
  onOpenOwned: (path: string) => void;
  onOpenGuest: (noteId: string) => void;
  onJoinSharedNote: () => void;
  /** Cancels a pending join request, or clears an expired one - see sharedNotesStore.ts's
   * removeGuestNote. Only meaningful for "pending"/"expired" rows. */
  onDismissGuestNote: (noteId: string) => void;
  /** Abandons a stalled attempt and starts a fresh one - see App.tsx's handleRetryGuestRequest. */
  onRetryGuestRequest: (noteId: string) => void;
  /** Forgets an owned note was ever shared - only offered when it has zero active collaborators
   * (see the "0 people" case: an invite was created and cancelled, or never redeemed, and the
   * empty share otherwise lingers forever since cancelling an invite alone doesn't remove it). */
  onUnshareOwned: (notePath: string) => void;
  activeSharedNoteId?: string | null;
}

/**
 * The combined "notes with more than one person on them" list - notes this device owns and has
 * shared out, plus notes this device has joined as a guest, in every state from a pending
 * request through active access. Shared between Sidebar.tsx (while a note is open) and Home.tsx
 * (while browsing), so the two stay in sync rather than drifting into two different designs.
 */
export function SharedNotesList({
  ownedSharedNotes,
  guestNotes,
  requestPhases,
  onOpenOwned,
  onOpenGuest,
  onJoinSharedNote,
  onDismissGuestNote,
  onRetryGuestRequest,
  onUnshareOwned,
  activeSharedNoteId,
}: SharedNotesListProps) {
  const nothingShared = ownedSharedNotes.length === 0 && guestNotes.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onJoinSharedNote}
        className="btn-ghost border-subtle flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium"
      >
        <UserPlus size={13} /> Join a shared note
      </button>

      {nothingShared && (
        <p className="text-tertiary px-1 text-xs leading-relaxed">
          Notes you share, or that someone else has shared with you, show up here.
        </p>
      )}

      {ownedSharedNotes.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="text-tertiary px-1 text-xs font-semibold uppercase tracking-wide">Shared by you</p>
          {ownedSharedNotes.map((summary) => {
            const activeCount = summary.acl.collaborators.filter((c) => c.status === "active").length;
            return (
              <div
                key={summary.notePath}
                className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-primary"
              >
                <button type="button" onClick={() => onOpenOwned(summary.notePath)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <FileText size={14} className="text-icon-outline shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{summary.noteTitle}</span>
                </button>
                {activeCount === 0 ? (
                  <button
                    type="button"
                    onClick={() => onUnshareOwned(summary.notePath)}
                    className="btn-ghost h-5 w-5 shrink-0"
                    title="Stop sharing - nobody has joined yet"
                    aria-label={`Stop sharing ${summary.noteTitle}`}
                  >
                    <X size={12} />
                  </button>
                ) : (
                  <span className="text-tertiary shrink-0 text-xs tabular-nums">
                    {activeCount} {activeCount === 1 ? "person" : "people"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {guestNotes.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="text-tertiary px-1 text-xs font-semibold uppercase tracking-wide">Shared with you</p>
          {guestNotes.map((note) => (
            <GuestNoteRow
              key={note.noteId}
              note={note}
              phase={requestPhases[note.noteId] ?? "connecting"}
              active={note.noteId === activeSharedNoteId}
              onOpen={() => onOpenGuest(note.noteId)}
              onDismiss={() => onDismissGuestNote(note.noteId)}
              onRetry={() => onRetryGuestRequest(note.noteId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GuestNoteRow({
  note,
  phase,
  active,
  onOpen,
  onDismiss,
  onRetry,
}: {
  note: GuestJoinedNote;
  phase: GuestRequestPhase;
  active: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const title = note.title ?? "Shared note";

  if (note.status === "pending") {
    const stalled = phase === "stalled";
    return (
      <div className="text-secondary flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
        {stalled ? (
          <AlertTriangle size={14} className="shrink-0 text-amber-500" />
        ) : (
          <Clock size={14} className="text-tertiary shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className={`shrink-0 text-xs ${stalled ? "text-amber-500" : "text-tertiary"}`}>
          {stalled
            ? "Stalled - both need to be online"
            : phase === "acknowledged"
              ? "Request sent - waiting for approval"
              : "Connecting…"}
        </span>
        {stalled && (
          <button
            type="button"
            onClick={onRetry}
            className="btn-ghost h-5 w-5 shrink-0"
            title="Retry"
            aria-label={`Retry joining ${title}`}
          >
            <RotateCw size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="btn-ghost h-5 w-5 shrink-0"
          title="Cancel request"
          aria-label={`Cancel request to join ${title}`}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  if (note.status === "expired") {
    return (
      <div className="text-tertiary flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
        <WifiOff size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-xs">Expired</span>
        <button
          type="button"
          onClick={onDismiss}
          className="btn-ghost h-5 w-5 shrink-0"
          title="Dismiss"
          aria-label={`Dismiss ${title}`}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ${
        active ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover hover:text-primary"
      }`}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {note.role === "editor" ? <Pencil size={13} className="shrink-0" /> : <Eye size={13} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      <span className="border-subtle text-tertiary shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
        {note.role}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="btn-ghost h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
        title="Remove from your shared notes"
        aria-label={`Remove ${title} from your shared notes`}
      >
        <X size={12} />
      </button>
    </div>
  );
}
