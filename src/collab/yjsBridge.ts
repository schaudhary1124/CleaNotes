import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { Room } from "trystero/nostr";
import { canEdit, getAcl, touchLastSeen } from "./acl";
import { fromHex, toHex } from "./hex";
import { type DeviceIdentity, sign, verifySignature } from "./identity";
import { deriveSessionRoom, joinTrysteroRoom } from "./signaling";
import type { CollabAcl, CollabRole } from "../types";

/**
 * The live CRDT sync engine, layered on top of signaling.ts's transport and acl.ts's
 * permissions. A note's Y.Doc is created fresh every time a session starts and discarded when
 * it ends - it is never persisted on its own. The note's `.md` file on disk stays the single
 * durable source of truth (unchanged autosave path in Editor.tsx); Yjs only carries live edits
 * between currently-connected peers while a session is open. See the collab plan's Phase 2.
 *
 * Topology is a strict star, hosted by the owner: guests only ever talk to the owner, never to
 * each other. This is what makes the owner's enforcement in hostSession below an actual
 * security boundary rather than a client-side courtesy - a peer's update is only ever applied
 * or rebroadcast after checking their *current* ACL entry, on every single message, not just
 * once at connection time.
 */

const FRAGMENT_NAME = "prosemirror";
const ACL_REFRESH_INTERVAL_MS = 2000;
const MAX_UPDATE_BYTES = 512 * 1024;
const MAX_AWARENESS_BYTES = 8 * 1024;
const RATE_LIMIT_BUCKET_SIZE = 50;
const RATE_LIMIT_REFILL_PER_SEC = 20;
const HELLO_FRESHNESS_MS = 30_000;
const SESSION_JOIN_TIMEOUT_MS = 20_000;

// A small curated palette rather than generated HSL, so presence colors stay legible (no
// muddy/too-light hues) - picked deterministically per public key so the same person keeps the
// same color across reconnects instead of it changing every session.
const PRESENCE_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#4ade80", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6"];

function colorForPubKey(pubKeyHex: string): string {
  let hash = 0;
  for (let i = 0; i < pubKeyHex.length; i++) hash = (hash * 31 + pubKeyHex.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

/** This device's own owner-side presence label - collaborators have their own displayName (set
 * during pairing), but the owner never entered one anywhere, so everyone sees this instead. */
const OWNER_PRESENCE_NAME = "Owner";

type SessionCtrlMessage =
  | { type: "hello"; pubKey: string; timestamp: number; signature: string }
  | { type: "welcome"; signature: string }
  | { type: "denied"; reason?: string }
  // Pushed to an already-connected peer when their role or the note's lock state changes -
  // lets their UI reflect it immediately instead of only finding out once they try to type
  // and the edit silently doesn't land (enforcement itself already happens on every message
  // regardless of this notice - see update.onMessage below).
  | { type: "state"; canEdit: boolean }
  // Pushed once, then that peer is dropped from authorizedPeers - distinct from "state" so the
  // guest can show a clear "access revoked" message and end its own session, rather than just
  // going quietly stale.
  | { type: "revoked" }
  // Pushed to everyone right before the owner deliberately ends the session (note closed/app
  // quit) - distinct from "revoked": access wasn't taken away, the owner just isn't hosting
  // right now. The guest can reconnect once the owner has the note open again.
  | { type: "closing" };

interface RateLimiter {
  tokens: number;
  lastRefill: number;
}

/** Consumes one token if available, refilling proportionally to elapsed time first - a simple
 * token bucket so a misbehaving (or malicious) editor-role peer can't flood the owner with
 * rapid-fire or oversized updates. Doesn't ban/disconnect on abuse, just quietly drops the
 * excess - a burst is throttled back to the refill rate rather than treated as fatal. */
function takeToken(bucket: RateLimiter): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(RATE_LIMIT_BUCKET_SIZE, bucket.tokens + ((now - bucket.lastRefill) / 1000) * RATE_LIMIT_REFILL_PER_SEC);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function signedText(...parts: string[]): Uint8Array {
  return new TextEncoder().encode(parts.join(":"));
}

export interface HostedSession {
  /** Bound into the owner's own Milkdown instance via collabSession - see Editor.tsx/setup.ts. */
  yXmlFragment: Y.XmlFragment;
  /** Live cursors/selections and presence - bound into the owner's own editor the same way as
   * yXmlFragment, and also the single source of truth the UI reads to show "who's here" (see
   * usePresence in Header.tsx/SharedNoteView.tsx) rather than a separately-tracked list. */
  awareness: Awareness;
  /** Re-reads the ACL immediately (bypassing the usual ~2s cache) and pushes a live "state" or
   * "revoked" notice to any connected peer whose access actually changed - call right after a
   * grant/revoke/lock action succeeds. Purely a promptness optimization for *connected* peers;
   * the enforcement in update.onMessage below re-checks the ACL on every message regardless, so
   * correctness never depends on this being called (a peer who isn't currently connected, or in
   * another window, still gets caught by that independent, disk-backed check within ~2s). */
  notifyAclChanged(): Promise<void>;
  /** Stops hosting: disconnects every currently-connected collaborator and leaves the signaling
   * room. Call when the note is closed/switched away from. */
  close(): void;
}

/**
 * Owner side: starts (or re-starts) the live session for a note that already has at least one
 * active collaborator, per its `.collab.json` ACL. Safe to call any time the owner has the note
 * open - collaborators can join/rejoin this same session at any point while it's running, with
 * no fresh invite needed (they were already vetted once, during pairing).
 */
export async function hostSession(notePath: string, identity: DeviceIdentity): Promise<HostedSession> {
  const acl = await getAcl(notePath);
  if (!acl) throw new Error("This note has never been shared.");

  const ydoc = new Y.Doc();
  const yXmlFragment = ydoc.getXmlFragment(FRAGMENT_NAME);
  // Destroyed automatically when ydoc is (see y-protocols/awareness.js: it registers its own
  // `doc.on('destroy', ...)` cleanup) - no separate teardown needed in close() below.
  const awareness = new Awareness(ydoc);
  // NOT setLocalStateField'd yet - deliberately deferred until after the relay listener below is
  // attached (see its own comment for why: setting it now, before an `await` yields control,
  // would fire and be missed by a listener that doesn't exist yet).

  const { roomId, password } = await deriveSessionRoom(acl.noteId);
  const room = joinTrysteroRoom(password, roomId);
  const ctrl = room.makeAction<SessionCtrlMessage>("cleanotes-session-ctrl");
  const update = room.makeAction<Uint8Array>("cleanotes-session-update");
  const awarenessAction = room.makeAction<Uint8Array>("cleanotes-session-awareness");

  let cachedAcl = acl;
  let cachedAt = Date.now();
  async function currentAcl(): Promise<CollabAcl> {
    if (Date.now() - cachedAt > ACL_REFRESH_INTERVAL_MS) {
      const fresh = await getAcl(notePath);
      if (fresh) {
        cachedAcl = fresh;
        cachedAt = Date.now();
      }
    }
    return cachedAcl;
  }

  const authorizedPeers = new Map<string, { pubKey: string; limiter: RateLimiter; lastKnownCanEdit: boolean }>();

  ctrl.onMessage = async (message, { peerId }) => {
    if (message.type !== "hello") return;
    if (Math.abs(Date.now() - message.timestamp) > HELLO_FRESHNESS_MS) return;

    let validHello = false;
    try {
      validHello = verifySignature(fromHex(message.signature), signedText("session", acl.noteId, String(message.timestamp)), message.pubKey);
    } catch {
      validHello = false;
    }
    if (!validHello) return; // not a real signature from the claimed pubKey - stay silent

    const latest = await currentAcl();
    const isActiveCollaborator = latest.collaborators.some((c) => c.pubKey === message.pubKey && c.status === "active");
    if (!isActiveCollaborator) {
      await ctrl.send({ type: "denied", reason: "You no longer have access to this note." }, { target: peerId });
      return;
    }

    authorizedPeers.set(peerId, {
      pubKey: message.pubKey,
      limiter: { tokens: RATE_LIMIT_BUCKET_SIZE, lastRefill: Date.now() },
      lastKnownCanEdit: canEdit(latest, message.pubKey),
    });
    await update.send(Y.encodeStateAsUpdate(ydoc), { target: peerId });
    const welcomeSignature = toHex(sign(identity, signedText("welcome", acl.noteId, message.pubKey)));
    await ctrl.send({ type: "welcome", signature: welcomeSignature }, { target: peerId });
    // Catch the newly-joined peer up on everyone already present, not just future changes.
    const knownClients = [...awareness.getStates().keys()];
    if (knownClients.length > 0) {
      await awarenessAction.send(encodeAwarenessUpdate(awareness, knownClients), { target: peerId });
    }
    void touchLastSeen(notePath, message.pubKey);
  };

  update.onMessage = async (data, { peerId }) => {
    const peer = authorizedPeers.get(peerId);
    if (!peer) return; // hasn't completed the hello handshake - never trust unauthenticated updates
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_UPDATE_BYTES) return;
    if (!takeToken(peer.limiter)) return;

    const latest = await currentAcl();
    if (!canEdit(latest, peer.pubKey)) return; // viewer, revoked, or the note is locked - drop, never apply
    Y.applyUpdate(ydoc, data, peerId);
  };

  // Tracks which Yjs awareness client ids belong to which Trystero peer, purely so a peer
  // disconnecting can clean up *their* presence (see room.onPeerLeave below) without guessing.
  const peerClientIds = new Map<string, Set<number>>();

  awarenessAction.onMessage = (data, { peerId }) => {
    const peer = authorizedPeers.get(peerId);
    if (!peer) return; // never trust presence data from an unauthenticated peer either
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_AWARENESS_BYTES) return;
    applyAwarenessUpdate(awareness, data, peerId);
  };

  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (typeof origin === "string") {
      let clientIds = peerClientIds.get(origin);
      if (!clientIds) {
        clientIds = new Set();
        peerClientIds.set(origin, clientIds);
      }
      for (const id of [...added, ...updated]) clientIds.add(id);
      for (const id of removed) clientIds.delete(id);
    }
    const changed = [...added, ...updated, ...removed];
    const encoded = encodeAwarenessUpdate(awareness, changed);
    for (const peerId of authorizedPeers.keys()) {
      if (origin === peerId) continue;
      void awarenessAction.send(encoded, { target: peerId });
    }
  });

  // Safe to set now that the listener above exists to actually broadcast it - see this
  // variable's declaration comment. (Newly-joining peers also get the *current* state
  // regardless, via the hello handler's catch-up send above - this isn't the only path.)
  awareness.setLocalStateField("user", { name: OWNER_PRESENCE_NAME, color: colorForPubKey(identity.publicKeyHex) });

  // Fires for every local OR accepted-remote change alike (Yjs doesn't distinguish the two at
  // this level) - broadcasting to everyone except the update's own origin peer both propagates
  // local edits to all collaborators and relays one collaborator's accepted edit to the others,
  // with the same line. Redundant re-delivery to the origin would be harmless anyway (Yjs
  // updates are idempotent), this just avoids the pointless echo.
  ydoc.on("update", (change: Uint8Array, origin: unknown) => {
    for (const peerId of authorizedPeers.keys()) {
      if (origin === peerId) continue;
      void update.send(change, { target: peerId });
    }
  });

  room.onPeerLeave = (peerId) => {
    authorizedPeers.delete(peerId);
    const clientIds = peerClientIds.get(peerId);
    if (clientIds && clientIds.size > 0) removeAwarenessStates(awareness, [...clientIds], "peer-left");
    peerClientIds.delete(peerId);
  };

  async function notifyAclChanged(): Promise<void> {
    // Bypass the cache - this is only called right after the owner's own action just wrote a
    // change, so there's no point waiting out the usual TTL to see it.
    const fresh = await getAcl(notePath);
    if (!fresh) return;
    cachedAcl = fresh;
    cachedAt = Date.now();

    for (const [peerId, peer] of authorizedPeers) {
      const stillActive = fresh.collaborators.some((c) => c.pubKey === peer.pubKey && c.status === "active");
      try {
        if (!stillActive) {
          await ctrl.send({ type: "revoked" }, { target: peerId });
          authorizedPeers.delete(peerId);
          const clientIds = peerClientIds.get(peerId);
          if (clientIds && clientIds.size > 0) removeAwarenessStates(awareness, [...clientIds], "revoked");
          peerClientIds.delete(peerId);
          continue;
        }
        const nowCanEdit = canEdit(fresh, peer.pubKey);
        if (nowCanEdit !== peer.lastKnownCanEdit) {
          peer.lastKnownCanEdit = nowCanEdit;
          await ctrl.send({ type: "state", canEdit: nowCanEdit }, { target: peerId });
        }
      } catch {
        // This peer's connection is probably already gone (e.g. they disconnected between the
        // owner's action and this push) - authorizedPeers.delete on the next onPeerLeave (or
        // the next update.onMessage's ACL check) will clean up; nothing more to do here.
      }
    }
  }

  return {
    yXmlFragment,
    awareness,
    notifyAclChanged,
    close: () => {
      // Best-effort: let connected peers know this was a deliberate close (note switched/app
      // closed) rather than leaving them to time out guessing why updates stopped. Not awaited -
      // close() itself stays synchronous, matching JoinSharedNoteDialog's/App.tsx's cleanup
      // effects, which call it from a non-async context. The teardown itself is pushed one tick
      // out so these sends have a chance to actually reach the WebRTC send buffer before the
      // peer connections close - closing a connection immediately after send() returns isn't
      // guaranteed to flush already-queued outgoing data on every platform.
      const peerIds = [...authorizedPeers.keys()];
      for (const peerId of peerIds) {
        void ctrl.send({ type: "closing" }, { target: peerId }).catch(() => {});
      }
      authorizedPeers.clear();
      setTimeout(() => {
        room.leave();
        ydoc.destroy();
      }, 0);
    },
  };
}

export interface JoinedSession {
  /** Already hydrated with the note's current content by the time this resolves - see the
   * join sequencing below. */
  yXmlFragment: Y.XmlFragment;
  /** Live cursors/selections and presence - see HostedSession.awareness's own comment; same
   * "single source of truth for the UI" role on this side too. */
  awareness: Awareness;
  /** False for viewers (or if the owner has the note locked at the moment of joining) - passed
   * straight through to Editor.tsx to set the editor read-only. Enforcement itself still lives
   * on the owner's side (hostSession above); this only controls this device's own UI. This is a
   * snapshot as of connect time - see onCanEditChanged in JoinSessionEvents for live updates. */
  canEdit: boolean;
  close(): void;
}

export interface JoinSessionEvents {
  /** The owner changed this device's role, or toggled the note's lock, while connected. */
  onCanEditChanged?: (canEdit: boolean) => void;
  /** The session ended from the owner's side - either access was actually revoked, or the
   * owner just isn't hosting right now (note closed/app quit) and may resume later. Either way
   * the session is now dead; callers should tear down their UI (see JoinSharedNoteDialog). */
  onEnded?: (reason: "revoked" | "closing") => void;
}

/**
 * Guest side: joins the note's ongoing session (already vetted via pairing, so no human
 * approval needed here - just a signed proof this device controls the pubKey the owner already
 * granted) and resolves once fully caught up. Rejects on denial or if the owner's device isn't
 * reachable/listening within 20s (most commonly: they don't have the note open right now).
 */
export function joinSession(
  noteId: string,
  ownerPubKey: string,
  role: CollabRole,
  identity: DeviceIdentity,
  displayName: string,
  events: JoinSessionEvents = {},
): Promise<JoinedSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ydoc = new Y.Doc();
    const yXmlFragment = ydoc.getXmlFragment(FRAGMENT_NAME);
    const awareness = new Awareness(ydoc);
    // NOT setLocalStateField'd yet - see the matching comment in hostSession above for why this
    // waits until the relay listener below actually exists.
    let room: Room | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room?.leave();
      ydoc.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error("Couldn't reach the owner's device. Make sure they still have this note open, then try again.")),
      SESSION_JOIN_TIMEOUT_MS,
    );

    deriveSessionRoom(noteId)
      .then(async ({ roomId, password }) => {
        if (settled) return;
        room = joinTrysteroRoom(password, roomId);
        const ctrl = room.makeAction<SessionCtrlMessage>("cleanotes-session-ctrl");
        const update = room.makeAction<Uint8Array>("cleanotes-session-update");
        const awarenessAction = room.makeAction<Uint8Array>("cleanotes-session-awareness");

        update.onMessage = (data) => {
          if (data instanceof Uint8Array) Y.applyUpdate(ydoc, data, "remote");
        };

        awarenessAction.onMessage = (data) => {
          if (data instanceof Uint8Array) applyAwarenessUpdate(awareness, data, "remote");
        };

        ctrl.onMessage = (message) => {
          // Messages that only make sense before the initial handshake resolves.
          if (!settled) {
            if (message.type === "welcome") {
              let validWelcome = false;
              try {
                validWelcome = verifySignature(fromHex(message.signature), signedText("welcome", noteId, identity.publicKeyHex), ownerPubKey);
              } catch {
                validWelcome = false;
              }
              if (!validWelcome) {
                fail(new Error("Could not verify the owner's identity - refusing to sync."));
                return;
              }
              settled = true;
              clearTimeout(timer);
              resolve({
                yXmlFragment,
                awareness,
                canEdit: role === "editor",
                close: () => {
                  room?.leave();
                  ydoc.destroy();
                },
              });
            } else if (message.type === "denied") {
              fail(new Error(message.reason ?? "Access to this note was denied."));
            }
            return;
          }

          // Everything past this point is a live event for an already-connected session.
          if (message.type === "state") {
            events.onCanEditChanged?.(message.canEdit);
          } else if (message.type === "revoked") {
            room?.leave();
            ydoc.destroy();
            events.onEnded?.("revoked");
          } else if (message.type === "closing") {
            room?.leave();
            ydoc.destroy();
            events.onEnded?.("closing");
          }
        };

        ydoc.on("update", (change: Uint8Array, origin: unknown) => {
          if (origin === "remote") return; // don't echo back what the owner just sent us
          void update.send(change);
        });

        awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
          if (origin === "remote") return;
          void awarenessAction.send(encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
        });

        room.onPeerJoin = async () => {
          const timestamp = Date.now();
          const signature = toHex(sign(identity, signedText("session", noteId, String(timestamp))));
          await ctrl.send({ type: "hello", pubKey: identity.publicKeyHex, timestamp, signature });
          // Deferred until there's actually a peer connected to broadcast to (see the
          // declaration comment above) - the owner is the only peer a guest ever has in this
          // star topology, so onPeerJoin firing at all means it's now safe to announce presence.
          awareness.setLocalStateField("user", { name: displayName, color: colorForPubKey(identity.publicKeyHex) });
        };
      })
      .catch(() => fail(new Error("Couldn't reach the shared note's signaling network.")));
  });
}
