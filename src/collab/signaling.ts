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
 * relay again. For the minority of strict-NAT/CGNAT pairs that can't reach each other directly,
 * `getIceServers` below fetches short-lived Cloudflare Realtime TURN credentials from our own
 * credentials Worker (see workers/turn-credentials/) as a relay fallback - callers should still
 * surface RedeemResult's "timeout" case for the rare case that fails too (Worker unreachable and
 * direct P2P both fail).
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
// address/port only, never any application data. Used as-is for direct P2P discovery, and as
// the fallback ICE config below if the TURN credentials Worker can't be reached.
const STUN_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: STUN_SERVERS }];

// Our own Cloudflare Worker (workers/turn-credentials/) that mints short-lived Realtime TURN
// credentials - the Worker holds the long-lived API token server-side and hands back a
// time-boxed username/credential pair, never the token itself. Fill in after `wrangler deploy`
// (and add the same host to tauri.conf.json's CSP connect-src).
const TURN_CREDENTIALS_URL = "https://cleanotes-turn-credentials.schaudhary-projects.workers.dev";
const ICE_FETCH_TIMEOUT_MS = 5_000;
// Refetch a bit ahead of the Worker-issued credential's actual expiry, so we're never caught
// trying to open a room with a credential that just expired.
const ICE_REFRESH_MARGIN_MS = 10 * 60_000;

let iceServersCache: { iceServers: RTCIceServer[]; expiresAt: number } | null = null;
// Coalesces concurrent callers (e.g. hostSession and a pairing attempt firing around the same
// moment) onto a single in-flight fetch instead of each starting their own.
let iceServersInFlight: Promise<RTCIceServer[]> | null = null;

async function fetchTurnIceServers(): Promise<RTCIceServer[]> {
  const res = await fetch(TURN_CREDENTIALS_URL, { method: "POST", signal: AbortSignal.timeout(ICE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`TURN credential fetch failed: ${res.status}`);
  const data = (await res.json()) as { iceServers: RTCIceServer[]; ttl?: number };
  const ttlMs = (data.ttl ?? 6 * 60 * 60) * 1000;
  iceServersCache = { iceServers: data.iceServers, expiresAt: Date.now() + ttlMs - ICE_REFRESH_MARGIN_MS };
  return data.iceServers;
}

/** Resolves to this session's ICE server config - Cloudflare's STUN+TURN mix when the
 * credentials Worker is reachable, so strict-NAT pairs can still connect via relay; falls back
 * to Google's public STUN-only servers (direct P2P only, same as before TURN was added) if the
 * Worker call fails for any reason, so a hiccup fetching credentials never blocks pairing/sync
 * outright - it just loses relay fallback for that one attempt. */
async function getIceServers(): Promise<RTCIceServer[]> {
  if (iceServersCache && iceServersCache.expiresAt > Date.now()) return iceServersCache.iceServers;
  if (!iceServersInFlight) {
    iceServersInFlight = fetchTurnIceServers()
      .catch(() => FALLBACK_ICE_SERVERS)
      .finally(() => {
        iceServersInFlight = null;
      });
  }
  return iceServersInFlight;
}

async function roomConfig(password: string): Promise<JoinRoomConfig> {
  return {
    appId: APP_ID,
    password,
    relayConfig: { urls: CURATED_RELAYS },
    rtcConfig: { iceServers: await getIceServers() },
  };
}

/** Joins a Trystero room with this module's shared appId/curated-relay/ICE config - the one
 * place both the pairing handshake (above) and the ongoing sync session (yjsBridge.ts) actually
 * call `joinRoom`, so both stay consistent if that config ever changes. */
export async function joinTrysteroRoom(password: string, roomId: string): Promise<Room> {
  return joinRoom(await roomConfig(password), roomId);
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
  // Sent by the owner the moment a valid "hello" arrives, before the human has actually made a
  // decision - lets the guest show "request sent, waiting for approval" instead of an
  // ambiguous "connecting" state that looks identical whether anyone is even listening.
  | { type: "received"; proof: string }
  | { type: "grant"; ownerPubKey: string; noteId: string; role: CollabRole; proof: string; signature: string }
  | { type: "deny"; proof: string; reason?: string }
  // Sent by the guest the moment it validates a "grant" (or receives a "deny") - the owner
  // waits briefly for this before deciding whether to report the decision as actually
  // delivered, so a guest that goes offline mid-handshake doesn't silently look successful.
  // Signed (unlike "hello"'s bare guestPubKey claim) so a third party who merely knows the
  // invite secret - not the same thing as controlling guestPubKey's private key - can't spoof
  // a fake delivery confirmation for someone else's still-pending request.
  | { type: "joined"; proof: string; guestPubKey: string; signature: string };

export interface PairingRequest {
  guestPubKey: string;
  displayName: string;
}

export type PairingDecision = { approved: true } | { approved: false; reason?: string };

export interface HostHandle {
  /** Stops listening for redemptions of this invite - call when the owner cancels it, the
   * invite expires, or a delivered decision no longer needs to keep listening for a retry (see
   * DeliveryResult.delivered). A late/duplicate attempt after this can't complete a pairing
   * unattended. */
  close(): void;
}

export interface DeliveryResult {
  guestPubKey: string;
  approved: boolean;
  /** Whether the guest's device confirmed receiving the decision within a few seconds. For an
   * approval, `false` does NOT mean access wasn't granted - the caller already wrote that to
   * the ACL before the decision was ever sent (see App.tsx's handleShareRequestDecision); it
   * only means we couldn't confirm the guest's device got the news *right now*, most commonly
   * because they went offline around the same moment. The room is deliberately kept open (not
   * torn down) in that case - see hostInvite's decidedForPubKey below - so the guest's own
   * automatic retry (their device re-announces itself the moment it's back online; see
   * redeemInvite/App.tsx's guest supervisor) gets caught and replayed the exact same decision,
   * without needing a fresh invite or bothering the owner again. */
  delivered: boolean;
}

const DELIVERY_ACK_TIMEOUT_MS = 8_000;

/**
 * Owner side: listens for valid redemption attempts of `invite`, surfacing the first distinct
 * pairing attempt to `onRequest` (which should show the "X wants to join as Editor" approval UI
 * and resolve once the person responds) and sending back a signed grant or a denial. A second
 * "hello" from a *different* guest after that gets an automatic "already used" denial without
 * bothering the owner again; a second "hello" from the *same* guest (most commonly a retry after
 * they were briefly offline) instead replays the exact decision that was already made for them,
 * so an interrupted delivery resolves itself the next time both devices are online, without
 * re-prompting the owner. Reports the outcome of each delivery attempt via `onDelivery`.
 */
export async function hostInvite(
  invite: InvitePayload,
  identity: DeviceIdentity,
  onRequest: (request: PairingRequest) => Promise<PairingDecision>,
  onDelivery?: (result: DeliveryResult) => void,
): Promise<HostHandle> {
  const { roomId, password } = await deriveInviteRoom(invite.secret);
  const room: Room = await joinTrysteroRoom(password, roomId);
  const auth = room.makeAction<AuthMessage>("cleanotes-auth");
  const expectedProof = await proofOfSecret(invite.secret);

  let decidedForPubKey: string | null = null;
  let decidedResponse: AuthMessage | null = null;
  const ackResolvers = new Map<string, () => void>();
  // Tracks each guest's most recent peerId (Trystero can hand out a new one on reconnect), so a
  // replayed decision after a retry goes to their *current* connection, not a stale one from
  // their first, since-dropped attempt.
  const latestPeerId = new Map<string, string>();

  function waitForDeliveryAck(guestPubKey: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ackResolvers.delete(guestPubKey);
        resolve(false);
      }, DELIVERY_ACK_TIMEOUT_MS);
      ackResolvers.set(guestPubKey, () => {
        clearTimeout(timer);
        ackResolvers.delete(guestPubKey);
        resolve(true);
      });
    });
  }

  auth.onMessage = async (message, { peerId }) => {
    if (message.type === "joined") {
      if (message.proof !== expectedProof) return;
      let validSignature = false;
      try {
        validSignature = verifySignature(
          fromHex(message.signature),
          new TextEncoder().encode(`joined:${invite.noteId}:${message.guestPubKey}`),
          message.guestPubKey,
        );
      } catch {
        validSignature = false;
      }
      // Ignore anything that isn't actually signed by the guestPubKey it claims - otherwise
      // anyone who merely knows the invite secret (not the same as controlling that private
      // key) could spoof a fake "delivered" ack for someone else's still-pending decision.
      if (validSignature) ackResolvers.get(message.guestPubKey)?.();
      return;
    }
    if (message.type !== "hello") return;
    if (message.proof !== expectedProof || message.noteId !== invite.noteId) return; // not this invite - stay silent, don't help a guesser

    latestPeerId.set(message.guestPubKey, peerId);
    await auth.send({ type: "received", proof: expectedProof }, { target: peerId });

    if (decidedForPubKey === message.guestPubKey) {
      if (decidedResponse) {
        const response = decidedResponse;
        await auth.send(response, { target: peerId });
        const delivered = await waitForDeliveryAck(message.guestPubKey);
        onDelivery?.({ guestPubKey: message.guestPubKey, approved: response.type === "grant", delivered });
      }
      // else: the human decision is still pending from this guest's first "hello" - nothing
      // more to do here, they'll get it once onRequest resolves below.
      return;
    }
    if (decidedForPubKey) {
      await auth.send({ type: "deny", proof: expectedProof, reason: "This invite has already been used." }, { target: peerId });
      return;
    }
    decidedForPubKey = message.guestPubKey; // set before awaiting the human decision, so a concurrent second hello can't also slip through

    try {
      const decision = await onRequest({ guestPubKey: message.guestPubKey, displayName: message.displayName });
      decidedResponse = decision.approved
        ? {
            type: "grant",
            ownerPubKey: identity.publicKeyHex,
            noteId: invite.noteId,
            role: invite.role,
            proof: expectedProof,
            signature: toHex(sign(identity, new TextEncoder().encode(`grant:${invite.noteId}:${message.guestPubKey}`))),
          }
        : { type: "deny", proof: expectedProof, reason: decision.reason };
      const targetPeerId = latestPeerId.get(message.guestPubKey) ?? peerId;
      await auth.send(decidedResponse, { target: targetPeerId });
      const delivered = await waitForDeliveryAck(message.guestPubKey);
      onDelivery?.({ guestPubKey: message.guestPubKey, approved: decision.approved, delivered });
    } catch {
      decidedResponse = { type: "deny", proof: expectedProof, reason: "Something went wrong on the owner's device." };
      const targetPeerId = latestPeerId.get(message.guestPubKey) ?? peerId;
      await auth.send(decidedResponse, { target: targetPeerId }).catch(() => {});
      onDelivery?.({ guestPubKey: message.guestPubKey, approved: false, delivered: false });
    }
  };

  return { close: () => room.leave() };
}

export type RedeemResult =
  | { status: "granted" }
  | { status: "denied"; reason?: string }
  | { status: "timeout" }
  /** Only ever produced by an explicit `signal.abort()` from the caller (see App.tsx's Retry
   * button) - not a real outcome from the owner's side, just "stop waiting, we're about to try
   * again from scratch." */
  | { status: "cancelled" };

export interface RedeemEvents {
  /** Fired once the owner's device confirms it received the join request - before they've
   * necessarily made a decision. Lets the caller show "request sent, waiting for approval"
   * instead of an ambiguous "connecting" state that looks identical whether anyone is even
   * listening. If this never fires, the owner most likely isn't currently online/hosting this
   * invite right now. */
  onAcknowledged?: () => void;
}

/**
 * Guest side: joins the invite's room, announces itself once the owner's device is present,
 * and waits for a signed grant or an explicit denial. Stays joined for the invite's entire
 * remaining lifetime (up to 24h) rather than a short fixed window - `room.onPeerJoin` fires
 * again whenever the owner's device shows up (or this device itself reconnects after being
 * briefly offline), even hours later, so this naturally supports an owner who's offline right
 * now approving the request once they next open the app, and vice versa. Resolves "timeout"
 * only once the invite itself expires - most commonly because the owner never approved it in
 * time, or because a direct connection could never be established at all (see this module's
 * no-TURN trade-off). Callers that want this to survive their own process restarting (e.g. the
 * guest closes and reopens the app before the owner responds) should persist the invite and
 * call this again on next launch - see sharedNotesStore.ts. `signal`, if given, lets the caller
 * abandon this attempt early (e.g. a manual "Retry" after it's been stalled a while) without
 * waiting for the full timeout.
 */
export function redeemInvite(
  invite: InvitePayload,
  identity: DeviceIdentity,
  displayName: string,
  events: RedeemEvents = {},
  signal?: AbortSignal,
): Promise<RedeemResult> {
  const timeoutMs = invite.expiresAt - Date.now();
  if (timeoutMs <= 0) {
    return Promise.resolve({ status: "denied", reason: "This invite has expired." });
  }

  return new Promise((resolve) => {
    let settled = false;
    let room: Room | null = null;

    const finish = (result: RedeemResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      room?.leave();
      resolve(result);
    };

    // Declared before the abort check below - `signal` being pre-aborted would otherwise call
    // finish() -> clearTimeout(timer) while `timer` is still in its temporal dead zone.
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

    const onAbort = () => finish({ status: "cancelled" });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);

    deriveInviteRoom(invite.secret)
      .then(async ({ roomId, password }) => {
        if (settled) return; // already timed out/cancelled before the room was even ready
        const joinedRoom = await joinTrysteroRoom(password, roomId);
        if (settled) {
          // Timed out/cancelled while ICE servers were fetching - finish() already ran without
          // this room (it didn't exist yet), so it's on us to leave it instead of leaking it.
          joinedRoom.leave();
          return;
        }
        room = joinedRoom;
        const auth = room.makeAction<AuthMessage>("cleanotes-auth");
        const proof = await proofOfSecret(invite.secret);

        auth.onMessage = (message) => {
          if (settled || message.proof !== proof) return;
          if (message.type === "received") {
            events.onAcknowledged?.();
          } else if (message.type === "grant") {
            if (message.ownerPubKey !== invite.ownerPubKey) return finish({ status: "denied", reason: "Owner key mismatch." });
            let validSignature = false;
            try {
              const signedText = new TextEncoder().encode(`grant:${message.noteId}:${identity.publicKeyHex}`);
              validSignature = verifySignature(fromHex(message.signature), signedText, message.ownerPubKey);
            } catch {
              validSignature = false;
            }
            if (!validSignature) return finish({ status: "denied", reason: "Could not verify the owner's signature." });
            const joinedSignature = toHex(
              sign(identity, new TextEncoder().encode(`joined:${message.noteId}:${identity.publicKeyHex}`)),
            );
            void auth.send({ type: "joined", proof, guestPubKey: identity.publicKeyHex, signature: joinedSignature });
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
