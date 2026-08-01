import { ed25519 } from "@noble/curves/ed25519";
import { invoke } from "@tauri-apps/api/core";
import { fromHex, toHex } from "./hex";

/** This device's persistent collaboration identity. `secretKey` never leaves this module or the
 * OS keychain it's persisted to (see src-tauri/src/identity.rs) - only `publicKeyHex` is ever
 * written to localStorage or sent to a peer. */
export interface DeviceIdentity {
  publicKeyHex: string;
  secretKey: Uint8Array;
}

// Public key only - safe to keep alongside the rest of the app's local settings (settings.ts
// uses the same localStorage mechanism). The private key lives exclusively in the OS keychain.
const PUBLIC_KEY_STORAGE_KEY = "cleanotes:collab:device-public-key";

async function createOrLoadIdentity(): Promise<DeviceIdentity> {
  const storedSecretHex = await invoke<string | null>("load_identity_secret");
  if (storedSecretHex) {
    const secretKey = fromHex(storedSecretHex);
    const publicKeyHex = toHex(ed25519.getPublicKey(secretKey));
    localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, publicKeyHex);
    return { publicKeyHex, secretKey };
  }

  const { secretKey, publicKey } = ed25519.keygen();
  await invoke("save_identity_secret", { secret: toHex(secretKey) });
  const publicKeyHex = toHex(publicKey);
  localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, publicKeyHex);
  return { publicKeyHex, secretKey };
}

// Memoized as an in-flight promise (not just a cached value) rather than the check-then-act
// pattern that would allow two racing callers to each generate and persist a *different*
// keypair, with the loser's `cached` object silently diverging from what's actually in the
// keychain - same race fsNotes.ts's withMetaLock exists to prevent for meta.json writes.
let identityPromise: Promise<DeviceIdentity> | null = null;

/** Loads this device's collaboration identity, generating and persisting a new Ed25519 keypair
 * in the OS keychain on first use. Safe to call from multiple places concurrently. */
export function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  if (!identityPromise) identityPromise = createOrLoadIdentity();
  return identityPromise;
}

/** This device's public key, if an identity has already been created this install - reads the
 * synchronously-available localStorage copy rather than the keychain, so UI (e.g. Settings'
 * device identity display) can render before/without awaiting loadOrCreateIdentity(). */
export function knownPublicKeyHex(): string | null {
  return localStorage.getItem(PUBLIC_KEY_STORAGE_KEY);
}

/** Signs `message` with this device's private key - used to prove identity during pairing/
 * reconnect handshakes (see the invite/signaling modules that build on this). */
export function sign(identity: DeviceIdentity, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, identity.secretKey);
}

/** Verifies a signature against a peer's known public key (hex) - used by both sides of a
 * handshake to authenticate each other without any central server. */
export function verifySignature(signature: Uint8Array, message: Uint8Array, publicKeyHex: string): boolean {
  return ed25519.verify(signature, message, fromHex(publicKeyHex));
}
