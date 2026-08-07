import { useEffect, useState } from "react";
import { hashAssetBytes, type AssetStore } from "../collab/assetStore";

/** How a board reaches binary content (images, voice recordings).
 *
 * Injected rather than importing `fsAssetStore` directly, for the same reason imageView.ts takes
 * one: the board UI runs in three places with three different backings - the desktop owner
 * (fsAssetStore), a desktop guest (fsAssetStore plus the session's peer fetch), and a browser
 * guest (idbAssetStore, no filesystem at all). A static import of fsNotes.ts would drag Tauri
 * APIs into the browser-guest bundle, which is a hard build failure - see
 * scripts/check-browser-bundle.mjs. */
export interface BoardAssets {
  store: AssetStore;
  /** Asks connected peers for bytes this device doesn't have locally - a collab session's
   * `resolveAsset` (see hostSession.ts/yjsBridge.ts). Absent for a solo board, where a local miss
   * is simply a missing asset. */
  fetchRemote?: (key: string) => Promise<Uint8Array>;
}

/** Stores bytes and returns the AssetStore key to reference them by. Content-addressed, so the
 * same image dropped on a board and pasted into a note dedupes onto one file. */
export async function putAsset(assets: BoardAssets, bytes: Uint8Array): Promise<string> {
  const key = await hashAssetBytes(bytes);
  await assets.store.put(key, bytes);
  return key;
}

/**
 * Resolves an AssetStore key into a blob URL usable as an `<img>`/`<audio>` src.
 *
 * Object URLs are cached per key at module scope and never revoked, matching imageView.ts's
 * `resolvedCache`: the same board image typically mounts and unmounts many times as it passes
 * through the viewport-culling window, and revoking on unmount would mean re-reading the bytes
 * (and flashing a blank frame) on every re-entry. The cache is bounded in practice by how many
 * distinct assets one board references, and dies with the window.
 */
const urlCache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

function loadAssetUrl(key: string, assets: BoardAssets): Promise<string | null> {
  const cached = urlCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const request = (async () => {
    let bytes = await assets.store.get(key);
    // A guest legitimately starts with none of the owner's images; the peer fetch is the normal
    // path there, not an error recovery.
    if (!bytes && assets.fetchRemote) {
      try {
        bytes = await assets.fetchRemote(key);
      } catch {
        bytes = null;
      }
    }
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(key) }));
    urlCache.set(key, url);
    return url;
  })().finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
}

function mimeFor(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "wav":
      return "audio/wav";
    default:
      // Content-hash keys carry no extension at all (see fsNotes.ts's CAS_DIR), and both <img> and
      // <audio> sniff the actual bytes - so an empty type is correct rather than a guess that
      // could contradict the content.
      return "";
  }
}

export function useAssetUrl(key: string | undefined, assets: BoardAssets): string | null {
  const [url, setUrl] = useState<string | null>(() => (key ? (urlCache.get(key) ?? null) : null));

  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    const cached = urlCache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    void loadAssetUrl(key, assets).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
    // `assets` is a stable per-mount object from the owning view; including it would re-fetch on
    // every render for no benefit, since a given board never swaps its backing store mid-life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return url;
}
