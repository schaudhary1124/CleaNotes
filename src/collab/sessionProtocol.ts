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
  // `features` is the owner's current FeatureFlags (see utils/settings.ts), sent once, same
  // "as of connect time, not live-pushed on a later change" limitation `title` already has;
  // lets a guest's editor hide affordances for features the owner has turned off locally.
  // Typed as a plain string-keyed record rather than FeatureFlags itself: Trystero's
  // makeAction<T> requires T to structurally satisfy JsonValue's index signature, which a
  // closed `interface` (however boolean-valued every one of its fields is) doesn't
  // automatically do - see yjsBridge.ts's toFeatureFlags for where this gets turned back into
  // a real, defaulted FeatureFlags.
  | {
      type: "welcome";
      // Identifies which hostSession() call produced this welcome (and its embedded snapshot) -
      // a fresh random id assigned once per call, since each call seeds an entirely new,
      // independently-constructed Y.Doc from disk (see hostSession.ts's own comment on why).
      // The guest compares this against whatever generation it's already on: the same value
      // means nothing actually changed (a harmless repeat "hello"/"welcome", safe to ignore);
      // a different value means the owner's document was recreated from scratch, and the
      // guest's existing local Y.Doc must be discarded and rebuilt from this snapshot, never
      // merged into - two independently-seeded Y.Docs for "the same" note are not the same CRDT
      // structure, and merging them duplicates every node onto the page (see yjsBridge.ts's
      // handling of this field for the full story of the bug this fixes).
      generation: string;
      // The owner's full current document state (Y.encodeStateAsUpdateV2), hex-encoded so it
      // fits this JSON-shaped message (Trystero's makeAction<T> requires T to be a plain
      // JsonValue when it isn't itself a raw binary payload - a Uint8Array nested inside an
      // object field doesn't qualify, same constraint noted on `features` below). Sent inline
      // with "welcome" itself rather than as a separate `update` message beforehand: `ctrl` and
      // `update` are different named actions, with no guarantee they arrive in the order they
      // were sent, so a separate pre-welcome update risked losing that race.
      snapshot: string;
      signature: string;
      title: string;
      features: Record<string, boolean>;
    }
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
