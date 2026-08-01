import type { CollabRole, GuestJoinedNote, GuestNoteStatus, OwnerPendingInvite } from "../types";

/**
 * Local (per-device) record of in-flight invites - the piece that was missing before: neither
 * `hostInvite`'s listener (owner side) nor `redeemInvite`'s wait (guest side) used to survive
 * their dialog closing, so a pending invite silently died the moment the owner clicked away or
 * the guest reopened the app. Persisting both sides here is what lets App.tsx's supervisor
 * effects resume them - see App.tsx's owner/guest invite supervisors.
 *
 * Deliberately localStorage, same as identity.ts's public-key cache and
 * JoinSharedNoteDialog.tsx's display-name field: this is small bookkeeping JSON, not vault
 * content, and never needs to be synced/backed up with the notes themselves.
 */

const OWNER_INVITES_KEY = "cleanotes:collab:owner-invites";
const GUEST_NOTES_KEY = "cleanotes:collab:guest-notes";

function readJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson<T>(key: string, value: T[]): void {
  localStorage.setItem(key, JSON.stringify(value));
}

/** All owner-side pending invites, with anything past its `expiresAt` dropped as a side effect
 * of reading - callers don't need to separately prune. */
export function listOwnerInvites(): OwnerPendingInvite[] {
  const all = readJson<OwnerPendingInvite>(OWNER_INVITES_KEY);
  const live = all.filter((i) => i.expiresAt > Date.now());
  if (live.length !== all.length) writeJson(OWNER_INVITES_KEY, live);
  return live;
}

/** Replaces any existing pending invite for the same note - a note only ever has one live
 * invite at a time (ShareDialog only offers "Create invite link" when there isn't one already). */
export function upsertOwnerInvite(invite: OwnerPendingInvite): void {
  const all = listOwnerInvites().filter((i) => i.notePath !== invite.notePath);
  writeJson(OWNER_INVITES_KEY, [...all, invite]);
}

export function removeOwnerInvite(secret: string): void {
  writeJson(
    OWNER_INVITES_KEY,
    listOwnerInvites().filter((i) => i.secret !== secret),
  );
}

/** Every guest-side entry that hasn't expired - a `"pending"` one past its `expiresAt` is
 * flipped to `"expired"` (kept, not dropped, so the sidebar can show it briefly) rather than
 * silently removed; already-resolved entries (`"active"`/`"denied"`/`"expired"`) are untouched
 * here since their `expiresAt` no longer governs anything. */
export function listGuestNotes(): GuestJoinedNote[] {
  const all = readJson<GuestJoinedNote>(GUEST_NOTES_KEY);
  let changed = false;
  const next = all.map((n) => {
    if (n.status === "pending" && n.expiresAt <= Date.now()) {
      changed = true;
      return { ...n, status: "expired" as const };
    }
    return n;
  });
  if (changed) writeJson(GUEST_NOTES_KEY, next);
  return next;
}

export function upsertGuestNote(note: GuestJoinedNote): void {
  const all = listGuestNotes().filter((n) => n.noteId !== note.noteId);
  writeJson(GUEST_NOTES_KEY, [...all, note]);
}

export function updateGuestNoteStatus(
  noteId: string,
  status: GuestNoteStatus,
  extra?: Partial<Pick<GuestJoinedNote, "title" | "deniedReason">>,
): void {
  const all = listGuestNotes();
  const next = all.map((n) => (n.noteId === noteId ? { ...n, status, ...extra } : n));
  writeJson(GUEST_NOTES_KEY, next);
}

export function removeGuestNote(noteId: string): void {
  writeJson(
    GUEST_NOTES_KEY,
    listGuestNotes().filter((n) => n.noteId !== noteId),
  );
}

/** Convenience for building the entry `JoinSharedNoteDialog` writes the moment a link is
 * submitted - see App.tsx's guest invite supervisor for what happens to it next. */
export function makePendingGuestNote(args: {
  noteId: string;
  ownerPubKey: string;
  role: CollabRole;
  secret: string;
  displayName: string;
  expiresAt: number;
}): GuestJoinedNote {
  return { ...args, status: "pending", createdAt: Date.now() };
}
