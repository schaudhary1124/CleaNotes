import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { Room } from "trystero/nostr";
import type { AssetStore } from "./assetStore";
import { createAssetChannel } from "./assetSync";
import { fromHex, toHex } from "./hex";
import { type DeviceIdentity, sign, verifySignature } from "./identity";
import { deriveSessionRoom, joinTrysteroRoom } from "./signaling";
import { AWARENESS_BROADCAST_THROTTLE_MS, colorForPubKey, CONTENT_BATCH_WINDOW_MS, FRAGMENT_NAME, type SessionCtrlMessage, signedText } from "./sessionProtocol";
import type { CollabRole, FeatureFlags, SketchStroke } from "../types";
import { DEFAULT_FEATURES } from "../utils/settings";

/** Turns the wire message's plain string-keyed record back into a real FeatureFlags, filling
 * in any missing/unrecognized keys from DEFAULT_FEATURES - same defensive merge loadSettings()
 * already does for its own localStorage read, applied here in case the owner's device is ever
 * running a different app version with a different flag set than this one. */
function toFeatureFlags(raw: Record<string, boolean>): FeatureFlags {
  return { ...DEFAULT_FEATURES, ...raw };
}

/**
 * Guest side of the live CRDT sync engine - see hostSession.ts for the owner side of the same
 * protocol (split into separate files so this one, imported directly by the browser-guest
 * build, never has to pull in acl.ts/fsNotes.ts's `@tauri-apps/plugin-fs` calls or the desktop
 * Milkdown plugin set, both reachable only from hostSession). Shared wire-protocol types and
 * helpers (the message shape, throttle windows, presence coloring) live in sessionProtocol.ts,
 * imported by both sides so they can never drift apart.
 *
 * A note's Y.Doc is created fresh every time a session starts and discarded when it ends - it
 * is never persisted on its own; the owner's device is the durable source of truth. This device
 * only ever talks to the owner directly (star topology, see hostSession.ts), never to other
 * guests.
 */

const SESSION_JOIN_TIMEOUT_MS = 20_000;

/** Thrown by joinSession specifically when the owner's device explicitly said no (currently only
 * "you're not an active collaborator anymore," i.e. revoked or never granted) - as opposed to any
 * other failure (offline, timeout, signaling hiccup), which is transient and worth retrying.
 * Callers should treat this as final: stop retrying and clean up, not back off and try again. */
export class SessionDeniedError extends Error {}

export interface JoinedSession {
  /** Already hydrated with the note's current content by the time this resolves - see the
   * join sequencing below. */
  yXmlFragment: Y.XmlFragment;
  /** The owner's real, filename-derived title, sent once this device is verified as an approved
   * collaborator (see SessionCtrlMessage's "welcome" comment) - not guessed from document
   * content, which previously produced wrong results for notes that don't open with a distinct
   * title-like first line. */
  title: string;
  /** The owner's FeatureFlags as of connect time (see SessionCtrlMessage's "welcome" comment
   * for the "sent once, not live-pushed" caveat) - lets a guest's editor hide affordances for
   * features the owner has turned off locally (e.g. code blocks). */
  features: FeatureFlags;
  /** Live cursors/selections and presence - see HostedSession.awareness's own comment in
   * hostSession.ts; same "single source of truth for the UI" role on this side too. */
  awareness: Awareness;
  /** Live ink strokes for Sketch mode - see HostedSession.ySketchStrokes's own comment
   * (hostSession.ts) for why this needs no wire protocol of its own. */
  ySketchStrokes: Y.Array<SketchStroke>;
  /** Resolves an image node's `src` to its bytes - this device's local asset store first, then
   * the owner if that misses. See HostedSession.resolveAsset's own comment. */
  resolveAsset(key: string): Promise<Uint8Array>;
  /** False for viewers (or if the owner has the note locked at the moment of joining) - passed
   * straight through to the editor to set it read-only. Enforcement itself still lives on the
   * owner's side (hostSession.ts); this only controls this device's own UI. This is a snapshot
   * as of connect time - see onCanEditChanged in JoinSessionEvents for live updates. */
  canEdit: boolean;
  /** Identifies which hostSession() call this session's content currently reflects - see
   * sessionProtocol.ts's "welcome".generation. Changes on a resync (see onResynced below) even
   * though the outer connection never actually dropped from this device's perspective. Callers
   * that bind an editor directly to yXmlFragment/awareness (Editor.tsx/BrowserEditor.tsx) should
   * key that editor's mount on this value, so a resync gets a genuinely fresh editor bound to
   * the fresh fields instead of an already-mounted one going stale. */
  generation: string;
  close(): void;
}

export interface JoinSessionEvents {
  /** The owner changed this device's role, or toggled the note's lock, while connected. */
  onCanEditChanged?: (canEdit: boolean) => void;
  /** The session ended from the owner's side - either access was actually revoked, or the
   * owner just isn't hosting right now (note closed/app quit) and may resume later. Either way
   * the session is now dead; callers should tear down their UI. */
  onEnded?: (reason: "revoked" | "closing") => void;
  /** The owner's device restarted hosting this note (a fresh, independently-seeded Y.Doc - see
   * hostSession.ts) while this connection never actually dropped from this device's
   * perspective - most commonly the note's sharing/ACL state changing, or the owner's app
   * restarting. A brand new JoinedSession (fresh yXmlFragment/awareness/generation) is handed
   * over rather than the existing one being mutated in place: see JoinedSession.generation's own
   * comment for why the old local Y.Doc is discarded outright, never merged into. Callers must
   * switch to the new session's fields (and remount whatever editor is bound to them) rather
   * than keep using the old one. */
  onResynced?: (session: JoinedSession) => void;
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
  assetStore: AssetStore,
  events: JoinSessionEvents = {},
): Promise<JoinedSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Which hostSession() generation the fields below currently reflect - null until the first
    // welcome arrives. See JoinedSession.generation's own comment.
    let currentGeneration: string | null = null;
    let ydoc = new Y.Doc();
    let yXmlFragment = ydoc.getXmlFragment(FRAGMENT_NAME);
    let ySketchStrokes = ydoc.getArray<SketchStroke>("sketch");
    let awareness = new Awareness(ydoc);
    // NOT setLocalStateField'd yet - see the matching comment in hostSession.ts for why this
    // waits until the relay listener below actually exists.
    let room: Room | null = null;
    // Set inside the room-join callback below, once awareness broadcasting is actually wired up
    // - declared here too so every teardown path (fail(), the explicit close() below, and the
    // revoked/closing branches) can clear it without leaving a dangling send scheduled after the
    // session has already ended.
    let awarenessBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
    // Same reasoning as awarenessBroadcastTimer above, for the content-update batch window.
    let contentBatchTimer: ReturnType<typeof setTimeout> | null = null;

    // Tears down the *local* Y.Doc/timers only - never the room/connection itself (a resync
    // needs the room to stay joined; only fail()/close()/revoked/closing below also leave it).
    const teardownLocalDoc = () => {
      if (awarenessBroadcastTimer) clearTimeout(awarenessBroadcastTimer);
      if (contentBatchTimer) clearTimeout(contentBatchTimer);
      awarenessBroadcastTimer = null;
      contentBatchTimer = null;
      ydoc.destroy(); // also destroys `awareness` - see hostSession.ts's identical comment
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      teardownLocalDoc();
      room?.leave();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error("Couldn't reach the owner's device. Make sure they still have this note open, then try again.")),
      SESSION_JOIN_TIMEOUT_MS,
    );

    deriveSessionRoom(noteId)
      .then(async ({ roomId, password }) => {
        if (settled) return;
        const joinedRoom = await joinTrysteroRoom(password, roomId);
        if (settled) {
          // Timed out/cancelled while ICE servers were fetching - fail() already ran without
          // this room (it didn't exist yet), so it's on us to leave it instead of leaking it.
          joinedRoom.leave();
          return;
        }
        room = joinedRoom;
        const ctrl = room.makeAction<SessionCtrlMessage>("cleanotes-session-ctrl");
        const update = room.makeAction<Uint8Array>("cleanotes-session-update");
        const awarenessAction = room.makeAction<Uint8Array>("cleanotes-session-awareness");
        // A guest only ever has the owner as a peer in this star topology, so no per-peer
        // allowlist to check the way hostSession.ts's authorizedPeers is - anyone who made it
        // into this signaling room already had the note's derived room password.
        const assetChannel = createAssetChannel(room, assetStore, () => true);
        // Set once the owner's first "hello" response (see room.onPeerJoin below) confirms who
        // that one peer actually is - resolveAsset has nobody to ask before then, same
        // "nothing to request from yet" gap a fresh join always has.
        let ownerPeerId: string | null = null;
        async function resolveAsset(key: string): Promise<Uint8Array> {
          return assetChannel.fetch(key, ownerPeerId ? [ownerPeerId] : []);
        }

        // Wires the "local edit -> broadcast to the owner" listeners onto whichever ydoc/
        // awareness are current. Called once for the pair created above, and again (against a
        // brand new pair) on every resync - see ctrl.onMessage's "welcome" handling below, and
        // JoinedSession.generation's own comment for why a resync needs an entirely fresh pair
        // rather than reusing this one.
        function wireLocalDoc() {
          // Same leading + trailing batching as hostSession.ts's ydoc.on("updateV2") - see its
          // comment for the full reasoning. Only one peer to exclude here (the owner), not a
          // set, since a guest only ever talks to the owner in this star topology.
          let pendingContentUpdates: Uint8Array[] = [];
          ydoc.on("updateV2", (change: Uint8Array, origin: unknown) => {
            if (origin === "remote") return; // don't echo back what the owner just sent us
            if (!contentBatchTimer) {
              void update.send(change);
              contentBatchTimer = setTimeout(() => {
                contentBatchTimer = null;
                if (pendingContentUpdates.length === 0) return;
                const merged =
                  pendingContentUpdates.length === 1 ? pendingContentUpdates[0] : Y.mergeUpdatesV2(pendingContentUpdates);
                pendingContentUpdates = [];
                void update.send(merged);
              }, CONTENT_BATCH_WINDOW_MS);
              return;
            }
            pendingContentUpdates.push(change);
          });

          // Coalesced the same way as hostSession.ts's awareness broadcast - see that one's
          // comment for why (essentially every keystroke plus an internal ~15s library
          // heartbeat, each otherwise triggering its own immediate WebRTC send).
          let pendingAwarenessClientIds = new Set<number>();
          awareness.on(
            "update",
            ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
              if (origin === "remote") return;
              for (const id of [...added, ...updated, ...removed]) pendingAwarenessClientIds.add(id);
              if (!awarenessBroadcastTimer) {
                awarenessBroadcastTimer = setTimeout(() => {
                  awarenessBroadcastTimer = null;
                  const clientIds = [...pendingAwarenessClientIds];
                  pendingAwarenessClientIds = new Set();
                  if (clientIds.length === 0) return;
                  void awarenessAction.send(encodeAwarenessUpdate(awareness, clientIds));
                }, AWARENESS_BROADCAST_THROTTLE_MS);
              }
            },
          );
        }
        wireLocalDoc();

        update.onMessage = (data) => {
          if (data instanceof Uint8Array) Y.applyUpdateV2(ydoc, data, "remote");
        };

        awarenessAction.onMessage = (data) => {
          if (data instanceof Uint8Array) applyAwarenessUpdate(awareness, data, "remote");
        };

        function buildSession(title: string, features: Record<string, boolean>): JoinedSession {
          return {
            yXmlFragment,
            ySketchStrokes,
            resolveAsset,
            title,
            features: toFeatureFlags(features),
            awareness,
            canEdit: role === "editor",
            generation: currentGeneration!,
            close: () => {
              teardownLocalDoc();
              room?.leave();
            },
          };
        }

        ctrl.onMessage = (message) => {
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
            // Same generation as what we already have - a harmless repeat welcome (e.g. a
            // redundant "hello" - see hostSession.ts, which doesn't bother distinguishing these
            // itself), nothing to rebuild.
            if (settled && message.generation === currentGeneration) return;

            let snapshot: Uint8Array;
            try {
              snapshot = fromHex(message.snapshot);
            } catch {
              return; // malformed - keep whatever we already have rather than corrupt it
            }

            if (settled) {
              // A resync: the owner's device restarted hosting this note (a fresh,
              // independently-seeded Y.Doc) while this connection never actually dropped from
              // here. See JoinedSession.generation's own comment for why the existing local doc
              // is discarded outright, never merged into.
              teardownLocalDoc();
              ydoc = new Y.Doc();
              yXmlFragment = ydoc.getXmlFragment(FRAGMENT_NAME);
              ySketchStrokes = ydoc.getArray<SketchStroke>("sketch");
              awareness = new Awareness(ydoc);
              wireLocalDoc();
            }
            Y.applyUpdateV2(ydoc, snapshot, "remote");
            currentGeneration = message.generation;

            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(buildSession(message.title, message.features));
            } else {
              // Deferred until now, same reasoning as the original onPeerJoin comment: this
              // fresh Awareness starts out empty, so presence needs re-announcing on it.
              awareness.setLocalStateField("user", { name: displayName, color: colorForPubKey(identity.publicKeyHex) });
              events.onResynced?.(buildSession(message.title, message.features));
            }
            return;
          }

          if (!settled) {
            if (message.type === "denied") fail(new SessionDeniedError(message.reason ?? "Access to this note was denied."));
            return;
          }

          // Everything past this point is a live event for an already-connected session.
          if (message.type === "state") {
            events.onCanEditChanged?.(message.canEdit);
          } else if (message.type === "revoked") {
            teardownLocalDoc();
            room?.leave();
            events.onEnded?.("revoked");
          } else if (message.type === "closing") {
            teardownLocalDoc();
            room?.leave();
            events.onEnded?.("closing");
          }
        };

        room.onPeerJoin = async (peerId) => {
          ownerPeerId = peerId;
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
