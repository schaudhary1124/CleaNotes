import type { Room } from "trystero/nostr";
import type { AssetStore } from "./assetStore";

/** Generous on purpose: this is a real binary transfer (a photo, potentially several MB),
 * possibly relayed through TURN rather than a direct path - not the small, latency-sensitive
 * control messages the rest of the session protocol (sessionProtocol.ts) is tuned around. */
const ASSET_REQUEST_TIMEOUT_MS = 30_000;

export interface AssetChannel {
  /** Resolves `key`'s bytes: the local store if already present, otherwise requests them from
   * whichever of `targetPeerIds` answers first and caches the result locally before returning.
   * Concurrent calls for the same key share one in-flight fetch rather than each firing their own
   * request. Rejects if the key is in nobody's local store (including this device's) and no
   * connected peer has it either. */
  fetch(key: string, targetPeerIds: string[]): Promise<Uint8Array>;
}

/**
 * Wires a request/response asset-transfer channel onto `room`, layered alongside the session's
 * existing ctrl/update/awareness actions (see hostSession.ts/yjsBridge.ts). Deliberately doesn't
 * put asset bytes anywhere near the Yjs `update` channel those use - an image node's `src` is
 * just the lookup key (see assetStore.ts), so the CRDT stream itself stays tiny regardless of how
 * large the image is. Reuses Trystero's own chunked binary transport (the same one already
 * carrying oversized `update` payloads under the hood) and its built-in request/response pairing,
 * rather than inventing a second wire protocol for exactly the same job.
 *
 * `canServe` gates who this device will hand bytes to when asked - see call sites for the two
 * different trust models (the owner checks its authorizedPeers allowlist; a guest only ever has
 * the owner as a peer in this star topology at all, so it serves unconditionally - the same trust
 * level `update`/`awareness` already extend to that one peer).
 */
export function createAssetChannel(room: Room, store: AssetStore, canServe: (peerId: string) => boolean): AssetChannel {
  const action = room.makeAction<{ key: string }, Uint8Array>("cleanotes-asset", {
    kind: "request",
    onRequest: async (data, ctx) => {
      if (!canServe(ctx.peerId)) throw new Error("not authorized");
      const bytes = await store.get(data.key);
      if (!bytes) throw new Error("asset not found");
      return bytes;
    },
  });

  const inFlight = new Map<string, Promise<Uint8Array>>();

  function requestFromPeers(key: string, targetPeerIds: string[]): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let settled = false;
      void action
        .requestMany(
          { key },
          {
            targets: targetPeerIds,
            timeoutMs: ASSET_REQUEST_TIMEOUT_MS,
            onResult: (result) => {
              if (settled || result.status !== "fulfilled") return;
              settled = true;
              resolve(result.value);
            },
          },
        )
        .then(() => {
          if (!settled) reject(new Error("Couldn't fetch that image from any connected peer"));
        });
    });
  }

  return {
    fetch(key, targetPeerIds) {
      const pending = inFlight.get(key);
      if (pending) return pending;
      const promise = (async () => {
        const cached = await store.get(key);
        if (cached) return cached;
        if (targetPeerIds.length === 0) throw new Error("No connected peer has this image yet");
        const bytes = await requestFromPeers(key, targetPeerIds);
        await store.put(key, bytes);
        return bytes;
      })();
      inFlight.set(key, promise);
      void promise.finally(() => inFlight.delete(key));
      return promise;
    },
  };
}
