import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { canEdit, getAcl, touchLastSeen } from "./acl";
import { createAssetChannel } from "./assetSync";
import { fromHex, toHex } from "./hex";
import { type DeviceIdentity, sign, verifySignature } from "./identity";
import { attachSharedTypesForKind, type KindSharedTypes } from "./kindSharedTypes";
import { seedSharedTypesFromDisk, wireSharedTypePersistence } from "./kindPersistence";
import { deriveSessionRoom, joinTrysteroRoom } from "./signaling";
import { AWARENESS_BROADCAST_THROTTLE_MS, colorForPubKey, CONTENT_BATCH_WINDOW_MS, type SessionCtrlMessage, signedText } from "./sessionProtocol";
import type { CollabAcl, FeatureFlags, NoteKind } from "../types";
import { fsAssetStore, getNoteKind, titleFromNotePath } from "../utils/fsNotes";

/**
 * Owner side of the live CRDT sync engine, layered on top of signaling.ts's transport and
 * acl.ts's permissions - see yjsBridge.ts for the guest side of the same protocol (split into
 * a separate file specifically so the browser-guest build, which only ever needs the guest
 * side, never has to pull in acl.ts/fsNotes.ts's `@tauri-apps/plugin-fs` calls or
 * milkdown/headlessParse.ts's dependency on the full desktop Milkdown plugin set - both are
 * reachable only from hostSession below, and both have module-level state that keeps a bundler
 * from fully tree-shaking them out even when none of their exports are actually referenced;
 * see scripts/check-browser-bundle.mjs, which is what caught this in the first place). A note's
 * Y.Doc is created fresh every time a session starts and discarded when it ends - it is never
 * persisted on its own. The note's `.md` file on disk stays the single durable source of truth
 * (unchanged autosave path in Editor.tsx); Yjs only carries live edits between currently-
 * connected peers while a session is open.
 *
 * Topology is a strict star, hosted by the owner: guests only ever talk to the owner, never to
 * each other. This is what makes the owner's enforcement in hostSession below an actual
 * security boundary rather than a client-side courtesy - a peer's update is only ever applied
 * or rebroadcast after checking their *current* ACL entry, on every single message, not just
 * once at connection time.
 */

const ACL_REFRESH_INTERVAL_MS = 2000;
const MAX_UPDATE_BYTES = 512 * 1024;
const MAX_AWARENESS_BYTES = 8 * 1024;
const RATE_LIMIT_BUCKET_SIZE = 50;
const RATE_LIMIT_REFILL_PER_SEC = 20;
const HELLO_FRESHNESS_MS = 30_000;

/** This device's own owner-side presence label - collaborators have their own displayName (set
 * during pairing), but the owner never entered one anywhere, so everyone sees this instead. */
const OWNER_PRESENCE_NAME = "Owner";

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

export interface HostedSession {
  /** Which view/editor this note opens with - determines which shared type(s) `shared` exposes.
   * See kindSharedTypes.ts. */
  kind: NoteKind;
  /** This note's kind-appropriate Yjs shared type(s) - e.g. `yXmlFragment`/`ySketchStrokes` for
   * Default/Fixed-Size, bound into the owner's own editor via collabSession (see
   * Editor.tsx/setup.ts). Seeded from disk and kept persisted back to it by
   * kindPersistence.ts - see seedSharedTypesFromDisk/wireSharedTypePersistence below. */
  shared: KindSharedTypes;
  /** Live cursors/selections and presence - bound into the owner's own editor alongside
   * `shared`, and also the single source of truth the UI reads to show "who's here" (see
   * usePresence in Header.tsx/SharedNoteView.tsx) rather than a separately-tracked list. */
  awareness: Awareness;
  /** Resolves an image node's `src` (a content hash, or a legacy relative attachment path) to its
   * bytes - checks this device's own disk first, then asks whichever connected collaborator(s)
   * have it (see assetSync.ts). Passed through to the image NodeView (imageView.ts) as its
   * network fallback when a plain local lookup misses. */
  resolveAsset(key: string): Promise<Uint8Array>;
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
export async function hostSession(notePath: string, identity: DeviceIdentity, features: FeatureFlags): Promise<HostedSession> {
  const acl = await getAcl(notePath);
  if (!acl) throw new Error("This note has never been shared.");
  const kind = await getNoteKind(notePath);

  // Identifies this specific call/Y.Doc instance to guests - see sessionProtocol.ts's "welcome"
  // field for why, and yjsBridge.ts for how a guest uses it to tell a harmless repeat welcome
  // apart from a real resync after this device restarted hosting.
  const generation = crypto.randomUUID();
  const ydoc = new Y.Doc();
  const shared = attachSharedTypesForKind(ydoc, kind);
  // Destroyed automatically when ydoc is (see y-protocols/awareness.js: it registers its own
  // `doc.on('destroy', ...)` cleanup) - no separate teardown needed in close() below.
  const awareness = new Awareness(ydoc);
  // NOT setLocalStateField'd yet - deliberately deferred until after the relay listener below is
  // attached (see its own comment for why: setting it now, before an `await` yields control,
  // would fire and be missed by a listener that doesn't exist yet).

  // Seed the freshly created (empty) Y.Doc with the note's current on-disk content before
  // anything below - the "hello" handshake's catch-up send, or a guest's hello landing mid-await
  // - can observe or broadcast it. A bare new Y.Doc must never reach a real ProseMirror editor
  // via ySyncPlugin: that plugin forcibly rewrites the editor to match whatever the fragment
  // holds, and the autosave that follows writes that straight back over the real .md file -
  // this exact gap previously wiped two real notes. See seedSharedTypesFromDisk's own doc
  // comment: it's meant precisely for "importing existing content to a Y.Doc for the first
  // time," and must run before `shared` is exposed to any sync machinery.
  await seedSharedTypesFromDisk(notePath, shared);

  const { roomId, password } = await deriveSessionRoom(acl.noteId);
  const room = await joinTrysteroRoom(password, roomId);
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

  const assetChannel = createAssetChannel(room, fsAssetStore, (peerId) => authorizedPeers.has(peerId));
  async function resolveAsset(key: string): Promise<Uint8Array> {
    return assetChannel.fetch(key, [...authorizedPeers.keys()]);
  }

  // Kind-dispatched disk persistence (debounced the same way Editor.tsx's own sketch autosave
  // already is) - see kindPersistence.ts's own comment for why non-Default/Fixed-Size kinds
  // need this rather than piggybacking on an always-open editor's autosave.
  const persistence = wireSharedTypePersistence(notePath, shared);

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
    const welcomeSignature = toHex(sign(identity, signedText("welcome", acl.noteId, message.pubKey)));
    await ctrl.send(
      {
        type: "welcome",
        generation,
        snapshot: toHex(Y.encodeStateAsUpdateV2(ydoc)),
        signature: welcomeSignature,
        title: titleFromNotePath(notePath),
        // Cast, not a lie: FeatureFlags' actual runtime shape (string keys, boolean values) is a
        // valid Record<string, boolean> - TS just doesn't infer that automatically for a closed
        // interface without an explicit index signature (see sessionProtocol.ts's own comment).
        features: features as unknown as Record<string, boolean>,
        kind,
      },
      { target: peerId },
    );
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
    Y.applyUpdateV2(ydoc, data, peerId);
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

  // Coalesces awareness broadcasts instead of sending one WebRTC message per change - without
  // this, every keystroke's cursor move (see y-prosemirror's cursor plugin, which updates
  // awareness on essentially every transaction) and y-protocols/awareness's own internal ~15s
  // "renew my clock" self-update each fired an immediate send, which adds up fast once relayed
  // through a TURN allocation rather than a direct P2P path. `pendingAwarenessOriginPeerIds`
  // tracks which peer(s) contributed to the batch being flushed, so a peer's own update still
  // never gets echoed back to them - same intent as the old per-event `origin === peerId` check,
  // just applied to the whole coalesced batch instead of one change at a time.
  let pendingAwarenessClientIds = new Set<number>();
  let pendingAwarenessOriginPeerIds = new Set<string>();
  let awarenessBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  function flushAwarenessBroadcast() {
    awarenessBroadcastTimer = null;
    const clientIds = [...pendingAwarenessClientIds];
    const originPeerIds = pendingAwarenessOriginPeerIds;
    pendingAwarenessClientIds = new Set();
    pendingAwarenessOriginPeerIds = new Set();
    if (clientIds.length === 0) return;
    const encoded = encodeAwarenessUpdate(awareness, clientIds);
    for (const peerId of authorizedPeers.keys()) {
      if (originPeerIds.has(peerId)) continue;
      void awarenessAction.send(encoded, { target: peerId });
    }
  }

  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (typeof origin === "string") {
      let clientIds = peerClientIds.get(origin);
      if (!clientIds) {
        clientIds = new Set();
        peerClientIds.set(origin, clientIds);
      }
      for (const id of [...added, ...updated]) clientIds.add(id);
      for (const id of removed) clientIds.delete(id);
      pendingAwarenessOriginPeerIds.add(origin);
    }
    for (const id of [...added, ...updated, ...removed]) pendingAwarenessClientIds.add(id);
    if (!awarenessBroadcastTimer) awarenessBroadcastTimer = setTimeout(flushAwarenessBroadcast, AWARENESS_BROADCAST_THROTTLE_MS);
  });

  // Safe to set now that the listener above exists to actually broadcast it - see this
  // variable's declaration comment. (Newly-joining peers also get the *current* state
  // regardless, via the hello handler's catch-up send above - this isn't the only path.)
  awareness.setLocalStateField("user", { name: OWNER_PRESENCE_NAME, color: colorForPubKey(identity.publicKeyHex) });

  let contentBatchTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingContentUpdates: Uint8Array[] = [];
  let pendingContentOriginPeerIds = new Set<string>();

  function broadcastContentUpdate(change: Uint8Array, excludePeerIds: Set<string>) {
    for (const peerId of authorizedPeers.keys()) {
      if (excludePeerIds.has(peerId)) continue;
      void update.send(change, { target: peerId });
    }
  }

  // Fires for every local OR accepted-remote change alike (Yjs doesn't distinguish the two at
  // this level) - broadcasting to everyone except the update's own origin peer both propagates
  // local edits to all collaborators and relays one collaborator's accepted edit to the others,
  // with the same line. Redundant re-delivery to the origin would be harmless anyway (Yjs
  // updates are idempotent), this just avoids the pointless echo.
  //
  // Leading + trailing batching: the very first change since idle is sent immediately (so a
  // remote collaborator sees the first keystroke of a new burst with no added latency), then
  // anything that follows within CONTENT_BATCH_WINDOW_MS is held and merged into one message at
  // the trailing edge instead of one WebRTC send per keystroke - each send has fixed framing
  // overhead (WebRTC/SCTP, plus TURN's relay framing when relayed), which a fast typist would
  // otherwise pay per character for no benefit, since nothing renders any faster than the network
  // round-trip anyway.
  ydoc.on("updateV2", (change: Uint8Array, origin: unknown) => {
    const originPeerId = typeof origin === "string" ? origin : null;
    if (!contentBatchTimer) {
      broadcastContentUpdate(change, originPeerId ? new Set([originPeerId]) : new Set());
      contentBatchTimer = setTimeout(() => {
        contentBatchTimer = null;
        if (pendingContentUpdates.length === 0) return;
        const merged = pendingContentUpdates.length === 1 ? pendingContentUpdates[0] : Y.mergeUpdatesV2(pendingContentUpdates);
        const excludePeerIds = pendingContentOriginPeerIds;
        pendingContentUpdates = [];
        pendingContentOriginPeerIds = new Set();
        broadcastContentUpdate(merged, excludePeerIds);
      }, CONTENT_BATCH_WINDOW_MS);
      return;
    }
    pendingContentUpdates.push(change);
    if (originPeerId) pendingContentOriginPeerIds.add(originPeerId);
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
    kind,
    shared,
    resolveAsset,
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
      if (awarenessBroadcastTimer) {
        clearTimeout(awarenessBroadcastTimer);
        awarenessBroadcastTimer = null;
      }
      if (contentBatchTimer) {
        clearTimeout(contentBatchTimer);
        contentBatchTimer = null;
      }
      void persistence.flush();
      persistence.dispose();
      setTimeout(() => {
        room.leave();
        ydoc.destroy();
      }, 0);
    },
  };
}
