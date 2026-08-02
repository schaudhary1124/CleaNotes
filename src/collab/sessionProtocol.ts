/**
 * Wire protocol and small helpers shared by both sides of a note's live session -
 * hostSession.ts (owner) and yjsBridge.ts (guest). Split out from what used to be one
 * yjsBridge.ts specifically so guest-only code (imported directly by the browser-guest build)
 * never has to import anything from hostSession.ts, which pulls in acl.ts/fsNotes.ts's
 * `@tauri-apps/plugin-fs` calls - see hostSession.ts's own module comment for the full story of
 * why that split exists.
 */

export const FRAGMENT_NAME = "prosemirror";

// Coalesces cursor-move/presence broadcasts (including y-protocols/awareness's own internal
// self-renewal heartbeat) into one send per window instead of one per change - see
// hostSession.ts's and yjsBridge.ts's respective awareness.on("update") handlers.
export const AWARENESS_BROADCAST_THROTTLE_MS = 200;
// Leading + trailing batch window for content updates - see hostSession.ts's/yjsBridge.ts's
// ydoc.on("updateV2") handlers for the full reasoning.
export const CONTENT_BATCH_WINDOW_MS = 50;

// A small curated palette rather than generated HSL, so presence colors stay legible (no
// muddy/too-light hues) - picked deterministically per public key so the same person keeps the
// same color across reconnects instead of it changing every session.
const PRESENCE_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#4ade80", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6"];

export function colorForPubKey(pubKeyHex: string): string {
  let hash = 0;
  for (let i = 0; i < pubKeyHex.length; i++) hash = (hash * 31 + pubKeyHex.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

export type SessionCtrlMessage =
  | { type: "hello"; pubKey: string; timestamp: number; signature: string }
  // `title` is the owner's real, filename-derived title - safe to send here (unlike the invite
  // payload, see invite.ts's "leaks nothing before vetting" comment) because by this point the
  // recipient is already an approved, ACL-verified collaborator, not an unvetted invite holder.
  | { type: "welcome"; signature: string; title: string }
  | { type: "denied"; reason?: string }
  // Pushed to an already-connected peer when their role or the note's lock state changes -
  // lets their UI reflect it immediately instead of only finding out once they try to type
  // and the edit silently doesn't land (enforcement itself already happens on every message
  // regardless of this notice - see hostSession.ts's update.onMessage).
  | { type: "state"; canEdit: boolean }
  // Pushed once, then that peer is dropped from authorizedPeers - distinct from "state" so the
  // guest can show a clear "access revoked" message and end its own session, rather than just
  // going quietly stale.
  | { type: "revoked" }
  // Pushed to everyone right before the owner deliberately ends the session (note closed/app
  // quit) - distinct from "revoked": access wasn't taken away, the owner just isn't hosting
  // right now. The guest can reconnect once the owner has the note open again.
  | { type: "closing" };

export function signedText(...parts: string[]): Uint8Array {
  return new TextEncoder().encode(parts.join(":"));
}
