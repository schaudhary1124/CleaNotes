/**
 * Local storage for a piece of binary content (currently just images) synced peer-to-peer during
 * a collab session, keyed by an opaque string - a content hash for anything inserted after this
 * existed, or a legacy per-note relative attachment path for images a desktop note already had on
 * disk before it (see fsNotes.ts's `writeAttachment`/`readAttachment`, which that legacy form
 * still round-trips through). Two implementations: `fsAssetStore` (src/utils/fsNotes.ts, desktop -
 * keyed content lives on disk) and `idbAssetStore` (src/browser-guest/idbAssetStore.ts, browser
 * guest - keyed content lives in IndexedDB, since a guest has no filesystem). See assetSync.ts for
 * how a miss here gets filled in from whichever connected peer already has the bytes.
 */
export interface AssetStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** Content hash used as the AssetStore key for every image inserted after this existed (see
 * fsAssetStore.get/put's own comment for the legacy relative-path form still used for images
 * that predate it). Hex-encoded SHA-256, computed with the standard Web Crypto API - available
 * identically in the Tauri webview and a plain browser tab, no platform-specific dependency. */
export async function hashAssetBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
