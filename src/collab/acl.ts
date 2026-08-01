import { deleteCollabAcl, flattenNotes, listNoteTree, readCollabAcl, writeCollabAcl } from "../utils/fsNotes";
import type { CollabAcl, CollabRole, Collaborator } from "../types";

/**
 * Business logic for a note's sharing/permissions state, layered over fsNotes.ts's
 * readCollabAcl/writeCollabAcl storage (the `.collab.json` sidecar). Every read here is a
 * fresh disk read, not an in-memory cache - the owner's device is the sole source of truth for
 * a note's ACL, and this module is deliberately the *only* place that's allowed to decide
 * whether a peer can view/edit/reconnect. Nothing in the signaling/sync layer should ever
 * apply an update without first checking here (see the security model in the collab plan).
 */

/** Reads a note's ACL, or null if it has never been shared. */
export function getAcl(notePath: string): Promise<CollabAcl | null> {
  return readCollabAcl(notePath);
}

/** Reads a note's ACL, creating one (owned by `ownerPubKey`, no collaborators yet, unlocked)
 * if this note has never been shared before. Called when the owner opens the Share dialog. */
export async function getOrCreateAcl(notePath: string, ownerPubKey: string): Promise<CollabAcl> {
  const existing = await readCollabAcl(notePath);
  if (existing) return existing;

  const fresh: CollabAcl = {
    version: 1,
    noteId: crypto.randomUUID(),
    ownerPubKey,
    locked: false,
    collaborators: [],
  };
  await writeCollabAcl(notePath, fresh);
  return fresh;
}

/** Grants (or updates the role of) a collaborator, keyed by their public key. Used once the
 * owner has interactively approved a pairing request - see the two-factor pairing requirement
 * in the security model. Reactivates a previously-revoked entry rather than duplicating it, so
 * `grantedAt` reflects the original grant and history isn't lost. */
export async function grantCollaborator(
  notePath: string,
  ownerPubKey: string,
  collaborator: { pubKey: string; displayName: string; role: CollabRole },
): Promise<CollabAcl> {
  const acl = await getOrCreateAcl(notePath, ownerPubKey);
  const existingIndex = acl.collaborators.findIndex((c) => c.pubKey === collaborator.pubKey);
  const entry: Collaborator = {
    pubKey: collaborator.pubKey,
    displayName: collaborator.displayName,
    role: collaborator.role,
    grantedAt: existingIndex === -1 ? Date.now() : acl.collaborators[existingIndex].grantedAt,
    lastSeenAt: existingIndex === -1 ? undefined : acl.collaborators[existingIndex].lastSeenAt,
    status: "active",
  };

  const collaborators =
    existingIndex === -1
      ? [...acl.collaborators, entry]
      : acl.collaborators.map((c, i) => (i === existingIndex ? entry : c));
  const next: CollabAcl = { ...acl, collaborators };
  await writeCollabAcl(notePath, next);
  return next;
}

/** Revokes a collaborator's access - kept in the list with status "revoked" (not deleted) so
 * the owner retains an audit trail of who has ever had access. Enforced going forward only:
 * see the plan's disclosed trade-off that this cannot erase content already synced to their
 * device. */
export async function revokeCollaborator(notePath: string, pubKey: string): Promise<CollabAcl | null> {
  const acl = await readCollabAcl(notePath);
  if (!acl) return null;
  const next: CollabAcl = {
    ...acl,
    collaborators: acl.collaborators.map((c) => (c.pubKey === pubKey ? { ...c, status: "revoked" as const } : c)),
  };
  await writeCollabAcl(notePath, next);
  return next;
}

/** Sets (or clears) the "instant lock" - every collaborator becomes temporarily read-only
 * regardless of role, without touching anyone's grant. Reversible, independent of revocation. */
export async function setLocked(notePath: string, locked: boolean): Promise<CollabAcl | null> {
  const acl = await readCollabAcl(notePath);
  if (!acl) return null;
  const next: CollabAcl = { ...acl, locked };
  await writeCollabAcl(notePath, next);
  return next;
}

/** Records that a collaborator just connected, for the owner's "who's had access, and when"
 * view - best-effort, not itself a security check. */
export async function touchLastSeen(notePath: string, pubKey: string): Promise<void> {
  const acl = await readCollabAcl(notePath);
  if (!acl) return;
  const next: CollabAcl = {
    ...acl,
    collaborators: acl.collaborators.map((c) => (c.pubKey === pubKey ? { ...c, lastSeenAt: Date.now() } : c)),
  };
  await writeCollabAcl(notePath, next);
}

/**
 * The single authorization check every inbound peer update must pass before the owner's
 * session code applies or rebroadcasts it. Intentionally strict: unknown peers, revoked
 * peers, and Viewers can never edit; when the note is locked, nobody but the check itself
 * (called with the owner's own pubKey never routes through here) can either. Client-side
 * `editable: false` is UX only - this function is the actual boundary.
 */
export function canEdit(acl: CollabAcl, pubKey: string): boolean {
  if (acl.locked) return false;
  const collaborator = acl.collaborators.find((c) => c.pubKey === pubKey);
  return collaborator?.status === "active" && collaborator.role === "editor";
}

/** Whether `pubKey` may receive this note's content/updates at all (Viewer or Editor, active,
 * regardless of lock - locking blocks writes, not reads). */
export function canView(acl: CollabAcl, pubKey: string): boolean {
  const collaborator = acl.collaborators.find((c) => c.pubKey === pubKey);
  return collaborator?.status === "active";
}

/** Removes a note's sharing sidecar entirely - for the "Shared by you" list's cleanup action,
 * when an invite was created but never redeemed (so the sidecar exists with zero collaborators)
 * and the owner just wants it gone rather than leaving an empty share lingering forever. Not
 * the same as revoking - this forgets the note was ever shared, whereas revoke keeps an audit
 * trail. Callers should only offer this when there are no active collaborators to disrupt. */
export async function unshareNote(notePath: string): Promise<void> {
  await deleteCollabAcl(notePath);
}

/** One note somewhere in the vault that has ever been shared, for the Settings panel's
 * vault-wide "who have I shared things with" view - see SettingsPanel.tsx's Collaboration
 * section. Walks every note in the vault checking for a `.collab.json` sidecar, so it's
 * meant for an explicit user action (opening Settings), not a hot path. */
export interface SharedNoteSummary {
  notePath: string;
  noteTitle: string;
  acl: CollabAcl;
}

export async function listSharedNotes(): Promise<SharedNoteSummary[]> {
  const tree = await listNoteTree();
  const notes = flattenNotes(tree);
  const results = await Promise.all(
    notes.map(async (note): Promise<SharedNoteSummary | null> => {
      const acl = await readCollabAcl(note.path);
      return acl ? { notePath: note.path, noteTitle: note.title, acl } : null;
    }),
  );
  return results.filter((r): r is SharedNoteSummary => r !== null);
}
