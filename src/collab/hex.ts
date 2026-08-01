/** Shared hex encoding for the collaboration feature - public keys, signatures, and invite
 * secrets are all passed around as hex strings (JSON-safe, easy to eyeball/debug/paste). */

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** A fresh cryptographically-random secret, hex-encoded - used for invite secrets. */
export function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** SHA-256 of a UTF-8 string, hex-encoded - used to derive signaling room ids/passwords and
 * proof-of-secret values from an invite secret without ever putting the raw secret itself on
 * the wire (see src/collab/signaling.ts). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}
