import type { AssetStore } from "../collab/assetStore";

/**
 * Browser guest's AssetStore (see src/collab/assetStore.ts) for P2P-synced image bytes - a guest
 * has no filesystem the way desktop's fsAssetStore (src/utils/fsNotes.ts) does, so this keeps
 * them in IndexedDB instead, keyed the same way (a content hash for images this guest or the
 * owner inserted after asset sync existed, a legacy relative attachment path for images already
 * on the owner's disk from before it - see fsAssetStore's own comment).
 */

const DB_NAME = "cleanotes-assets";
const STORE_NAME = "assets";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Couldn't open the local image cache"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

export const idbAssetStore: AssetStore = {
  async get(key) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as Uint8Array | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Couldn't read from the local image cache"));
    });
  },
  async put(key, bytes) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Couldn't write to the local image cache"));
    });
  },
};
