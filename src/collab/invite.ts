import type { CollabRole } from "../types";
import { randomHex } from "./hex";

/**
 * A single-use, time-boxed grant a note's owner hands to someone they want to collaborate
 * with. Deliberately carries no note title/path - only the opaque `noteId` - so a leaked or
 * intercepted invite string reveals nothing about what it's for (see the security model's
 * structural-isolation principle). Knowing this payload is necessary but never sufficient to
 * gain access: the owner must still interactively approve the specific incoming device on
 * first pairing (see src/collab/acl.ts's grantCollaborator, called only after that approval).
 */
export interface InvitePayload {
  v: 1;
  noteId: string;
  role: CollabRole;
  /** Hex-encoded random secret. Doubles as the seed for the signaling room id (always hashed
   * before being published to any public relay - see signaling.ts) and as the key used to
   * encrypt the pairing handshake. */
  secret: string;
  ownerPubKey: string;
  expiresAt: number;
}

const INVITE_TTL_MS = 15 * 60 * 1000;
const SECRET_BYTES = 32;
const PUBKEY_HEX_LENGTH = 64; // Ed25519 public key: 32 bytes, hex-encoded
const SECRET_HEX_LENGTH = SECRET_BYTES * 2;

// Cosmetic label, not (yet) an OS-registered URL scheme - see the collab plan's Phase 4 note
// about optionally adopting tauri-plugin-deep-link later. For now this is just a prefix users
// paste in full into the "Enter invite link" field; parseInvite tolerates it being stripped.
const INVITE_PREFIX = "cleanotes-invite://";

export class InviteError extends Error {}

/** Creates a fresh invite for `noteId`, expiring in 15 minutes. Callers still need to persist
 * nothing here - the invite is stateless; the owner's signaling module is what decides whether
 * to honor a redemption attempt against it (see signaling.ts). */
export function createInvite(noteId: string, role: CollabRole, ownerPubKey: string): InvitePayload {
  return {
    v: 1,
    noteId,
    role,
    secret: randomHex(SECRET_BYTES),
    ownerPubKey,
    expiresAt: Date.now() + INVITE_TTL_MS,
  };
}

/** Encodes an invite as a copy/paste-able string. */
export function serializeInvite(invite: InvitePayload): string {
  const json = JSON.stringify(invite);
  return INVITE_PREFIX + base64UrlEncode(new TextEncoder().encode(json));
}

/** Decodes and validates a pasted invite string, throwing `InviteError` with a message safe to
 * show the user directly if it's malformed, corrupted, or expired. */
export function parseInvite(text: string): InvitePayload {
  const trimmed = text.trim();
  const payload = trimmed.startsWith(INVITE_PREFIX) ? trimmed.slice(INVITE_PREFIX.length) : trimmed;

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    throw new InviteError("That doesn't look like a valid CleaNotes invite link.");
  }

  const invite = validate(decoded);
  if (invite.expiresAt < Date.now()) {
    throw new InviteError("This invite has expired - ask the note's owner to share a new one.");
  }
  return invite;
}

function validate(value: unknown): InvitePayload {
  const malformed = () => new InviteError("That invite link looks corrupted or incomplete.");
  if (typeof value !== "object" || value === null) throw malformed();

  const v = value as Record<string, unknown>;
  if (v.v !== 1) throw new InviteError("This invite was created by an incompatible version of CleaNotes.");
  if (typeof v.noteId !== "string" || v.noteId.length === 0) throw malformed();
  if (v.role !== "viewer" && v.role !== "editor") throw malformed();
  if (typeof v.secret !== "string" || v.secret.length !== SECRET_HEX_LENGTH) throw malformed();
  if (typeof v.ownerPubKey !== "string" || v.ownerPubKey.length !== PUBKEY_HEX_LENGTH) throw malformed();
  if (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) throw malformed();

  return {
    v: 1,
    noteId: v.noteId,
    role: v.role,
    secret: v.secret,
    ownerPubKey: v.ownerPubKey,
    expiresAt: v.expiresAt,
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array {
  const restored = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = restored.padEnd(Math.ceil(restored.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
