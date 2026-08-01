import { joinRoom, type JoinRoomConfig, type Room } from "trystero/nostr";
import type { CollabRole } from "../types";
import { type DeviceIdentity, sign, verifySignature } from "./identity";
import type { InvitePayload } from "./invite";
import { fromHex, sha256Hex, toHex } from "./hex";

/**
 * Serverless WebRTC pairing over Trystero's Nostr strategy: public, decentralized relays are
 * used *only* to exchange the WebRTC SDP/ICE handshake (and, on top of that, our own
 * proof-of-secret application handshake below) - once a peer connection is up, everything rides
 * the DTLS-encrypted WebRTC DataChannel directly between the two devices, never touching the
 * relay again. See the collab plan's "known trade-offs" section: no TURN relay is used (by
 * design, to stay 100% free/serverless), so a minority of strict-NAT pairs simply won't be able
 * to connect directly - callers should surface RedeemResult's "timeout" case accordingly.
 *
 * Room ids/passwords are always sha256 of the invite secret plus a domain-separation prefix,
 * never the raw secret - so a relay operator (or anyone else watching the public relay) never
 * sees the actual secret, only an unguessable-without-it derived identifier. Completing a
 * WebRTC connection in the right room is still not sufficient for access on its own: both sides
 * exchange an explicit proof-of-secret before either will treat the other as legitimate (see
 * AuthMessage below), and the owner's "grant" is additionally signed with their long-term
 * identity key so the guest has a real cryptographic binding for all future reconnects, not
 * just "someone in the right room said so."
 */

const APP_ID = "cleanotes-collab-v1";

// A deliberately small, curated subset of Trystero's ~50 default community Nostr relays,
// rather than the full default pool: lets tauri.conf.json's CSP connect-src name exact hosts
// instead of wildcarding all outbound wss:// traffic, and pins to relays run by established
// projects (Damus, nos.social, Coracle, Mostro) instead of trusting whichever of ~50 mostly
// unbranded personal relays Trystero's redundancy setting happens to pick per session.
const CURATED_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://bucket.coracle.social",
  "wss://purplerelay.com",
  "wss://relay.mostro.network",
];

// Google's long-standing public STUN endpoints - discovery of this device's own reachable
// address/port only, never any application data. No TURN relay - see this module's doc
// comment on why, and the collab plan's disclosed trade-off.
const STUN_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

function roomConfig(password: string): JoinRoomConfig {
  return {
    appId: APP_ID,
    password,
    relayConfig: { urls: CURATED_RELAYS },
    rtcConfig: { iceServers: [{ urls: STUN_SERVERS }] },
  };
}

/** Joins a Trystero room with this module's shared appId/curated-relay/STUN config - the one
 * place both the pairing handshake (above) and the ongoing sync session (yjsBridge.ts) actually
 * call `joinRoom`, so both stay consistent if that config ever changes. */
export function joinTrysteroRoom(password: string, roomId: string): Room {
  return joinRoom(roomConfig(password), roomId);
}

const SESSION_DOMAIN = "cleanotes-session-v1";

/** Derives the room id/password for a note's *ongoing* collaboration session, from its noteId
 * alone (not tied to any specific pairing) - this is the room every currently-active
 * collaborator (re)connects to for as long as the owner has the note open, whether that's
 * minutes after being granted or days later. Safe to derive from noteId alone: it's a random
 * UUID (122 bits of entropy), so unguessable regardless of whether it's treated as a secret -
 * see yjsBridge.ts for why *joining* this room still isn't the same as being authorized to
 * sync (a revoked collaborator may still remember a noteId; the owner's session code is what
 * actually checks the current ACL, same structural-isolation principle as the pairing flow). */
export async function deriveSessionRoom(noteId: string): Promise<{ roomId: string; password: string }> {
  const [roomId, password] = await Promise.all([
    sha256Hex(`${SESSION_DOMAIN}:room:${noteId}`),
    sha256Hex(`${SESSION_DOMAIN}:password:${noteId}`),
  ]);
  return { roomId, password };
}

const INVITE_DOMAIN = "cleanotes-invite-v1";

/** Derives a room id and room password from an invite secret - both are sha256 of the secret
 * under distinct domain-separated prefixes, so knowing one doesn't help derive the other, and
 * neither reveals the secret itself. */
async function deriveInviteRoom(secret: string): Promise<{ roomId: string; password: string }> {
  const [roomId, password] = await Promise.all([
    sha256Hex(`${INVITE_DOMAIN}:room:${secret}`),
    sha256Hex(`${INVITE_DOMAIN}:password:${secret}`),
  ]);
  return { roomId, password };
}

/** A value only someone who knows the raw invite secret could produce - exchanged by both
 * sides as an explicit, auditable "prove you know the secret" step that doesn't depend on any
 * assumption about exactly what Trystero's own room password mechanism does or doesn't cover. */
function proofOfSecret(secret: string): Promise<string> {
  return sha256Hex(`${INVITE_DOMAIN}:proof:${secret}`);
}

type AuthMessage =
  | { type: "hello"; noteId: string; guestPubKey: string; displayName: string; proof: string }
  | { type: "grant"; ownerPubKey: string; noteId: string; role: CollabRole; proof: string; signature: string }
  | { type: "deny"; proof: string; reason?: string };

export interface PairingRequest {
  guestPubKey: string;
  displayName: string;
}

export type PairingDecision = { approved: true } | { approved: false; reason?: string };

export interface HostHandle {
  /** Stops listening for redemptions of this invite - call when the Share dialog closes or
   * the invite expires, so a late/duplicate attempt can't complete a pairing unattended. */
  close(): void;
}

/**
 * Owner side: listens for exactly one valid redemption of `invite`, surfacing each distinct
 * pairing attempt to `onRequest` (which should show the "X wants to join as Editor" approval UI
 * and resolve once the person responds) and sending back a signed grant or a denial. The first
 * request with a valid proof-of-secret consumes the invite - anyone else who redeems the same
 * link afterward (e.g. a forwarded/leaked link) gets an automatic "already used" denial without
 * bothering the owner again.
 */
export async function hostInvite(
  invite: InvitePayload,
  identity: DeviceIdentity,
  onRequest: (request: PairingRequest) => Promise<PairingDecision>,
): Promise<HostHandle> {
  const { roomId, password } = await deriveInviteRoom(invite.secret);
  const room: Room = joinTrysteroRoom(password, roomId);
  const auth = room.makeAction<AuthMessage>("cleanotes-auth");
  const expectedProof = await proofOfSecret(invite.secret);

  let consumed = false;

  auth.onMessage = async (message, { peerId }) => {
    if (message.type !== "hello") return;
    if (message.proof !== expectedProof || message.noteId !== invite.noteId) return; // not this invite - stay silent, don't help a guesser

    if (consumed) {
      await auth.send({ type: "deny", proof: expectedProof, reason: "This invite has already been used." }, { target: peerId });
      return;
    }
    consumed = true; // set before awaiting the human decision below, so a concurrent second hello can't also slip through

    try {
      const decision = await onRequest({ guestPubKey: message.guestPubKey, displayName: message.displayName });
      if (decision.approved) {
        const signature = toHex(
          sign(identity, new TextEncoder().encode(`grant:${invite.noteId}:${message.guestPubKey}`)),
        );
        await auth.send(
          { type: "grant", ownerPubKey: identity.publicKeyHex, noteId: invite.noteId, role: invite.role, proof: expectedProof, signature },
          { target: peerId },
        );
      } else {
        await auth.send({ type: "deny", proof: expectedProof, reason: decision.reason }, { target: peerId });
      }
    } catch {
      await auth.send({ type: "deny", proof: expectedProof, reason: "Something went wrong on the owner's device." }, { target: peerId });
    } finally {
      room.leave();
    }
  };

  return { close: () => room.leave() };
}

export type RedeemResult =
  | { status: "granted" }
  | { status: "denied"; reason?: string }
  | { status: "timeout" };

const AUTH_TIMEOUT_MS = 60_000;

/**
 * Guest side: joins the invite's room, announces itself once the owner's device is present,
 * and waits for a signed grant or an explicit denial. Resolves "timeout" if nothing comes back
 * within 60s - most commonly because the owner isn't actively hosting this invite right now
 * (dialog closed, app not running) or because a direct connection couldn't be established at
 * all (see this module's no-TURN trade-off).
 */
export function redeemInvite(invite: InvitePayload, identity: DeviceIdentity, displayName: string): Promise<RedeemResult> {
  if (invite.expiresAt < Date.now()) {
    return Promise.resolve({ status: "denied", reason: "This invite has expired." });
  }

  return new Promise((resolve) => {
    let settled = false;
    let room: Room | null = null;

    const finish = (result: RedeemResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room?.leave();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ status: "timeout" }), AUTH_TIMEOUT_MS);

    deriveInviteRoom(invite.secret)
      .then(async ({ roomId, password }) => {
        if (settled) return; // already timed out before the room was even ready
        room = joinTrysteroRoom(password, roomId);
        const auth = room.makeAction<AuthMessage>("cleanotes-auth");
        const proof = await proofOfSecret(invite.secret);

        auth.onMessage = (message) => {
          if (settled || message.proof !== proof) return;
          if (message.type === "grant") {
            if (message.ownerPubKey !== invite.ownerPubKey) return finish({ status: "denied", reason: "Owner key mismatch." });
            let validSignature = false;
            try {
              const signedText = new TextEncoder().encode(`grant:${message.noteId}:${identity.publicKeyHex}`);
              validSignature = verifySignature(fromHex(message.signature), signedText, message.ownerPubKey);
            } catch {
              validSignature = false;
            }
            if (!validSignature) return finish({ status: "denied", reason: "Could not verify the owner's signature." });
            finish({ status: "granted" });
          } else if (message.type === "deny") {
            finish({ status: "denied", reason: message.reason });
          }
        };

        room.onPeerJoin = () => {
          void auth.send({
            type: "hello",
            noteId: invite.noteId,
            guestPubKey: identity.publicKeyHex,
            displayName,
            proof,
          });
        };
      })
      .catch(() => finish({ status: "denied", reason: "Couldn't reach the invite's signaling network." }));
  });
}
