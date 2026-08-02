import { ed25519 } from "@noble/curves/ed25519";
import { fromHex, toHex } from "./hex";
import type { DeviceIdentity } from "./identity";

/**
 * The browser-guest build's counterpart to identity.ts - same DeviceIdentity shape and the same
 * @noble/curves/ed25519 calls, but persisted directly in localStorage instead of the desktop
 * app's OS keychain, since a plain browser tab has no keychain to call into. Deliberately does
 * not import anything at all from identity.ts itself: that file imports `invoke` from
 * @tauri-apps/api/core at module scope specifically to reach the desktop keychain (see
 * src-tauri/src/identity.rs) - only the DeviceIdentity *type* is reused (a type-only import,
 * erased entirely at compile time, so it carries no risk of pulling that in).
 *
 * This is one browser's identity, not one person's - a different browser (or the same browser
 * with storage cleared) generates its own keypair and is a distinct collaborator from the
 * owner's point of view, exactly like two different desktop installs would be.
 */

const SECRET_KEY_STORAGE_KEY = "cleanotes:browser-collab:device-secret-key";
const PUBLIC_KEY_STORAGE_KEY = "cleanotes:browser-collab:device-public-key";

function createOrLoadIdentity(): DeviceIdentity {
  const storedSecretHex = localStorage.getItem(SECRET_KEY_STORAGE_KEY);
  if (storedSecretHex) {
    const secretKey = fromHex(storedSecretHex);
    const publicKeyHex = toHex(ed25519.getPublicKey(secretKey));
    localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, publicKeyHex);
    return { publicKeyHex, secretKey };
  }

  const { secretKey, publicKey } = ed25519.keygen();
  localStorage.setItem(SECRET_KEY_STORAGE_KEY, toHex(secretKey));
  const publicKeyHex = toHex(publicKey);
  localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, publicKeyHex);
  return { publicKeyHex, secretKey };
}

let cached: DeviceIdentity | null = null;

/** Loads this browser's collaboration identity, generating and persisting a new Ed25519 keypair
 * in localStorage on first visit. Synchronous (unlike identity.ts's version) since localStorage
 * itself is synchronous - there's no OS keychain round-trip to await here. */
export function loadOrCreateIdentity(): DeviceIdentity {
  if (!cached) cached = createOrLoadIdentity();
  return cached;
}

/** This browser's public key, if an identity has already been created - same synchronous-read
 * role as identity.ts's knownPublicKeyHex. */
export function knownPublicKeyHex(): string | null {
  return localStorage.getItem(PUBLIC_KEY_STORAGE_KEY);
}
