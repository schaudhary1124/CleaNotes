//! Secure storage for the collaboration feature's device identity secret.
//!
//! The actual Ed25519 keypair logic lives entirely on the TS side (src/collab/identity.ts) so
//! there's exactly one place that ever touches the cryptography. This module is deliberately
//! "dumb": it only ever sees an opaque secret string to store or retrieve in the OS-native
//! credential store, never anything about what that string means.

use keyring::Entry;

const SERVICE: &str = "com.cleanotes.app";
const ACCOUNT: &str = "device-identity-secret";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|err| err.to_string())
}

/// Persists the device identity secret in the OS keychain, overwriting any previous value.
#[tauri::command]
pub fn save_identity_secret(secret: String) -> Result<(), String> {
    entry()?.set_password(&secret).map_err(|err| err.to_string())
}

/// Reads back the device identity secret, or `None` if this device hasn't generated one yet.
#[tauri::command]
pub fn load_identity_secret() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}
