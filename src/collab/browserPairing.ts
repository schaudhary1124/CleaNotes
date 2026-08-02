import type { Room } from "trystero/nostr";
import type { CollabRole } from "../types";
import { type DeviceIdentity, sign, verifySignature } from "./identity";
import { type HostHandle, joinTrysteroRoom } from "./signaling";
import { fromHex, sha256Hex, toHex } from "./hex";
import { base64UrlDecode, base64UrlEncode } from "./invite";

/**
 * PIN-based browser pairing: a standing, re-enterable entry gate for a note (see
 * `BrowserPinState` in types.ts), structurally parallel to hostInvite/redeemInvite in
 * signaling.ts but deliberately simpler and multi-redemption:
 *  - no human-approval step - a valid PIN auto-grants, matching browser guests' "no request
 *    access, wait for approval" requirement,
 *  - not single-use - every distinct browser identity that submits the current PIN gets its own
 *    Collaborator grant, so the PIN is a shared front door, not a one-time ticket,
 *  - no "received"/"joined" delivery-ack round trip - hostInvite needs that to survive a human
 *    taking a while to decide; there's no equivalent delay here.
 *
 * hostBrowserPairing (owner side) takes its ACL-granting capability as a parameter rather than
 * importing grantCollaborator from acl.ts directly. acl.ts pulls in fsNotes.ts's
 * `@tauri-apps/plugin-fs` calls, and this file is imported directly by the browser-guest build
 * (via redeemBrowserPin below), which must never depend on Tauri APIs - this keeps that one,
 * heaviest Tauri surface out of this file's import graph entirely rather than relying on
 * tree-shaking for it. `sign`/`verifySignature` from ./identity and `joinTrysteroRoom` from
 * ./signaling are still imported directly below - both are already unavoidably part of the
 * browser build's module graph via signaling.ts's own use of identity.ts, so there's nothing
 * left to gain by not importing them here too. See scripts/check-browser-bundle.mjs for how "no
 * Tauri code actually ships" is verified for the pieces that do rely on tree-shaking.
 */

const BROWSER_PIN_DOMAIN = "cleanotes-browser-pin-v1";
const PIN_DIGITS = 6;

/** A fresh random PIN (never user-chosen) for enabling/regenerating a note's browser access -
 * consistent with this codebase's existing pattern of always generating secrets (see hex.ts's
 * randomHex for invites) rather than accepting user-chosen ones, which tend to be weaker.
 * 6 digits: easy to read aloud/type on a phone: relies on noteId (in deriveBrowserPairRoom)
 * being unguessable to keep the pairing room itself undiscoverable, and on each guess costing an
 * attacker a real WebRTC negotiation against the owner's device - see this module's security
 * notes in the implementation plan for the full reasoning. */
export function generateBrowserPin(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 10 ** PIN_DIGITS;
  return value.toString().padStart(PIN_DIGITS, "0");
}

/** Derives this note+PIN's pairing room - deliberately distinct from both deriveInviteRoom and
 * deriveSessionRoom in signaling.ts, so a PIN-guessing attempt can only ever reach this vetting
 * gate, never the actual sync channel. Requires *both* noteId and pin: knowing only the PIN
 * (a small space by design, see BrowserPinState's comment) is useless without noteId (a random
 * UUID, unguessable), and knowing only noteId (public, carried in the browser-guest link) is
 * useless without the PIN - same domain-separated sha256 pattern as every other room derivation
 * in this codebase, just keyed on two inputs instead of one. */
async function deriveBrowserPairRoom(noteId: string, pin: string): Promise<{ roomId: string; password: string }> {
  const [roomId, password] = await Promise.all([
    sha256Hex(`${BROWSER_PIN_DOMAIN}:room:${noteId}:${pin}`),
    sha256Hex(`${BROWSER_PIN_DOMAIN}:password:${noteId}:${pin}`),
  ]);
  return { roomId, password };
}

function browserPairProof(noteId: string, pin: string): Promise<string> {
  return sha256Hex(`${BROWSER_PIN_DOMAIN}:proof:${noteId}:${pin}`);
}

type BrowserPairMessage =
  | { type: "hello"; guestPubKey: string; displayName: string; proof: string }
  | { type: "grant"; ownerPubKey: string; noteId: string; role: CollabRole; proof: string; signature: string }
  | { type: "deny"; proof: string; reason?: string };

const RATE_LIMIT_BUCKET_SIZE = 5;
const RATE_LIMIT_REFILL_PER_SEC = 5 / 60; // ~5 recovered per minute

interface RateLimiter {
  tokens: number;
  lastRefill: number;
}

/** Same token-bucket shape as yjsBridge.ts's local RateLimiter/takeToken - duplicated rather
 * than exported from there, since it's ten lines and not worth a cross-file refactor of that
 * file for. See hostBrowserPairing's own comment for what this actually protects against. */
function takeToken(bucket: RateLimiter): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(RATE_LIMIT_BUCKET_SIZE, bucket.tokens + ((now - bucket.lastRefill) / 1000) * RATE_LIMIT_REFILL_PER_SEC);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Owner side: listens for PIN redemptions on `pin`'s derived room and auto-grants every valid
 * one via the injected `grant` callback (in practice, acl.ts's grantCollaborator curried by the
 * caller - see App.tsx). Call whenever a note has browser access enabled; the caller is
 * responsible for closing this and starting a fresh one under the new room whenever the PIN
 * changes or browser access is disabled (this function itself has no notion of "the PIN
 * changed," it only ever listens on the one room `pin` derived to at call time).
 */
export async function hostBrowserPairing(
  noteId: string,
  pin: string,
  role: CollabRole,
  identity: DeviceIdentity,
  grant: (guestPubKey: string, displayName: string) => Promise<void>,
): Promise<HostHandle> {
  const { roomId, password } = await deriveBrowserPairRoom(noteId, pin);
  const room: Room = await joinTrysteroRoom(password, roomId);
  const pair = room.makeAction<BrowserPairMessage>("cleanotes-browser-pair");
  const expectedProof = await browserPairProof(noteId, pin);
  const limiter: RateLimiter = { tokens: RATE_LIMIT_BUCKET_SIZE, lastRefill: Date.now() };

  pair.onMessage = async (message, { peerId }) => {
    if (message.type !== "hello") return;
    // A mismatched proof should be structurally unreachable here - this room id/password is
    // itself derived from (noteId, pin) together, so a guess against a *different* pin lands in
    // a different, empty room and never reaches this handler at all. That per-guess cost (an
    // entire new Trystero room join/negotiation against this device) is the real defense against
    // PIN-guessing, not this in-room check - this is just defense in depth for this exact room,
    // same spirit as hostInvite's equivalent proof check in signaling.ts, plus a small courtesy
    // rate limit in case that assumption is ever wrong.
    if (message.proof !== expectedProof || !takeToken(limiter)) return;

    try {
      await grant(message.guestPubKey, message.displayName);
      const signature = toHex(sign(identity, new TextEncoder().encode(`grant:${noteId}:${message.guestPubKey}`)));
      await pair.send(
        { type: "grant", ownerPubKey: identity.publicKeyHex, noteId, role, proof: expectedProof, signature },
        { target: peerId },
      );
    } catch {
      await pair
        .send({ type: "deny", proof: expectedProof, reason: "Something went wrong on the owner's device." }, { target: peerId })
        .catch(() => {});
    }
  };

  return { close: () => room.leave() };
}

export type RedeemBrowserPinResult =
  | { status: "granted"; role: CollabRole }
  | { status: "denied"; reason?: string }
  | { status: "timeout" };

const REDEEM_TIMEOUT_MS = 15_000;

/**
 * Guest side: joins the PIN-derived room, announces itself once the owner's device is present,
 * and waits for a signed grant. A wrong PIN derives a different (almost certainly empty) room,
 * so this can't distinguish "wrong PIN" from "owner isn't online right now" - both surface as
 * "timeout", the same honest limitation redeemInvite already has in signaling.ts.
 */
export function redeemBrowserPin(
  noteId: string,
  ownerPubKey: string,
  pin: string,
  identity: DeviceIdentity,
  displayName: string,
): Promise<RedeemBrowserPinResult> {
  return new Promise((resolve) => {
    let settled = false;
    let room: Room | null = null;

    const finish = (result: RedeemBrowserPinResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room?.leave();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ status: "timeout" }), REDEEM_TIMEOUT_MS);

    deriveBrowserPairRoom(noteId, pin)
      .then(async ({ roomId, password }) => {
        if (settled) return;
        const joinedRoom = await joinTrysteroRoom(password, roomId);
        if (settled) {
          // Timed out while ICE servers were fetching - finish() already ran without this room
          // (it didn't exist yet), so it's on us to leave it instead of leaking it.
          joinedRoom.leave();
          return;
        }
        room = joinedRoom;
        const pair = room.makeAction<BrowserPairMessage>("cleanotes-browser-pair");
        const proof = await browserPairProof(noteId, pin);

        pair.onMessage = (message) => {
          if (settled || message.proof !== proof) return;
          if (message.type === "grant") {
            if (message.ownerPubKey !== ownerPubKey) return finish({ status: "denied", reason: "Owner key mismatch." });
            let validSignature = false;
            try {
              const signedText = new TextEncoder().encode(`grant:${message.noteId}:${identity.publicKeyHex}`);
              validSignature = verifySignature(fromHex(message.signature), signedText, message.ownerPubKey);
            } catch {
              validSignature = false;
            }
            if (!validSignature) return finish({ status: "denied", reason: "Could not verify the owner's signature." });
            finish({ status: "granted", role: message.role });
          } else if (message.type === "deny") {
            finish({ status: "denied", reason: message.reason });
          }
        };

        room.onPeerJoin = () => {
          void pair.send({ type: "hello", guestPubKey: identity.publicKeyHex, displayName, proof });
        };
      })
      .catch(() => finish({ status: "denied", reason: "Couldn't reach the signaling network." }));
  });
}

// --- Shareable link: noteId + ownerPubKey only. The PIN is deliberately never embedded here -
// it's typed separately by the guest (see the browser-guest app's PIN entry screen) - so "the
// link" and "the PIN" stay two genuinely separate factors instead of one bundled into the other.

export interface BrowserLinkPayload {
  noteId: string;
  ownerPubKey: string;
}

const PUBKEY_HEX_LENGTH = 64; // Ed25519 public key: 32 bytes, hex-encoded

export class BrowserLinkError extends Error {}

/** Encodes noteId+ownerPubKey as the fragment of a browser-guest link. Both are already treated
 * as safe to expose elsewhere in this codebase (noteId: a 122-bit random UUID, see
 * deriveSessionRoom's own comment; ownerPubKey: a public key by definition) - and a URL fragment
 * specifically is never sent in the HTTP request itself, so this never reaches GitHub Pages'
 * server either. */
export function serializeBrowserLink(payload: BrowserLinkPayload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

/** The deployed browser-guest page's base URL - see vite.browser-guest.config.ts's outDir
 * (docs/edit/) and the repo's existing GitHub Pages setup (docs/index.html). Centralized here so
 * ShareDialog.tsx (and anywhere else that ever needs it) build the link the same way. */
export const BROWSER_GUEST_BASE_URL = "https://schaudhary1124.github.io/CleaNotes/edit/";

/** The full shareable link for a note's browser access - the PIN is deliberately not part of
 * this, see serializeBrowserLink's own comment. */
export function buildBrowserLink(payload: BrowserLinkPayload): string {
  return `${BROWSER_GUEST_BASE_URL}#${serializeBrowserLink(payload)}`;
}

/** Decodes a browser-guest link's fragment (the part after '#') - throws BrowserLinkError with a
 * message safe to show the user directly if it's missing or malformed. */
export function parseBrowserLink(fragment: string): BrowserLinkPayload {
  const trimmed = fragment.trim();
  if (!trimmed) throw new BrowserLinkError("This link is missing its note - check you copied the whole thing.");

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(trimmed)));
  } catch {
    throw new BrowserLinkError("This link looks corrupted or incomplete.");
  }

  if (typeof decoded !== "object" || decoded === null) throw new BrowserLinkError("This link looks corrupted or incomplete.");
  const v = decoded as Record<string, unknown>;
  if (typeof v.noteId !== "string" || v.noteId.length === 0) throw new BrowserLinkError("This link looks corrupted or incomplete.");
  if (typeof v.ownerPubKey !== "string" || v.ownerPubKey.length !== PUBKEY_HEX_LENGTH) {
    throw new BrowserLinkError("This link looks corrupted or incomplete.");
  }
  return { noteId: v.noteId, ownerPubKey: v.ownerPubKey };
}
