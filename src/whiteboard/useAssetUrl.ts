import { useEffect, useState } from "react";
import { fsAssetStore } from "../utils/fsNotes";

/** Resolves an AssetStore key (a content hash, or a legacy relative path - see fsNotes.ts's
 * fsAssetStore) into a blob URL usable as an `<img>`/`<audio>` src.
 *
 * Object URLs are cached per key at module scope and never revoked, matching imageView.ts's
 * `resolvedCache`: the same board image typically mounts and unmounts many times as it scrolls
 * through the viewport-culling window, and revoking on unmount would mean re-reading the file (and
 * flashing a blank frame) on every re-entry. The cache is bounded in practice by how many distinct
 * assets one vault holds, and dies with the window. */
const urlCache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

function loadAssetUrl(key: string): Promise<string | null> {
  const cached = urlCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const request = (async () => {
    const bytes = await fsAssetStore.get(key);
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

export function useAssetUrl(key: string | undefined): string | null {
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
    void loadAssetUrl(key).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return url;
}
