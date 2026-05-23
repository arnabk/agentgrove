//! At-rest encryption for provider API keys.
//!
//! Settings-pasted API keys (e.g. for 9router or future OpenAI-
//! compatible providers) are written to SQLite as ciphertext so a
//! casual peek at the DB file doesn't leak the key. The encryption
//! key (a 32-byte XChaCha20-Poly1305 root key) lives at
//! `<state_dir>/secrets.key`, chmod 600, generated on first need.
//!
//! Threat model:
//!   * Defends against passive disclosure of the DB file alone
//!     (e.g. uploaded as part of a bug report).
//!   * Does NOT defend against a local attacker with read access to
//!     `state_dir` — both files are recoverable in that case. This
//!     matches our existing trust boundary: the server binds to
//!     loopback and trusts the host.
//!   * Losing `secrets.key` invalidates every existing ciphertext;
//!     the FE just prompts the user to paste their keys again.
//!
//! Algorithm choice: XChaCha20-Poly1305 with the extended 24-byte
//! nonce. Nonces are randomly generated per encryption — the
//! 192-bit space is large enough that collisions are negligible
//! without persistent counter state.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Filename for the machine-bound key under `<state_dir>`.
const KEY_FILENAME: &str = "secrets.key";

/// Errors raised by the secrets module.
#[derive(Debug, Error)]
pub enum SecretError {
    /// I/O error reading or writing the key file.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// The on-disk key file exists but isn't the expected 32 bytes.
    #[error("key file at {0} is corrupt (expected 32 bytes, got {1})")]
    KeyCorrupt(PathBuf, usize),
    /// AEAD encrypt failed (out-of-memory or key misuse).
    #[error("encrypt failed: {0}")]
    EncryptFailed(String),
    /// AEAD decrypt failed — wrong key, corrupt ciphertext, or
    /// tampered tag.
    #[error("decrypt failed: ciphertext rejected (wrong key or tampering)")]
    DecryptFailed,
    /// base64 payload was malformed.
    #[error("base64 decode failed: {0}")]
    Base64(#[from] base64::DecodeError),
}

/// Owns the machine-bound root key. Cheap to clone.
#[derive(Clone)]
pub struct SecretKeyring {
    cipher: XChaCha20Poly1305,
}

impl SecretKeyring {
    /// Load the keyring from `<state_dir>`. Generates a fresh
    /// 32-byte key if `secrets.key` doesn't exist yet.
    ///
    /// # Errors
    /// - [`SecretError::Io`] when the file can't be created or read.
    /// - [`SecretError::KeyCorrupt`] when the existing file isn't 32 bytes.
    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, SecretError> {
        let path = state_dir.as_ref().join(KEY_FILENAME);
        let key_bytes = if path.exists() {
            let bytes = std::fs::read(&path)?;
            if bytes.len() != 32 {
                return Err(SecretError::KeyCorrupt(path, bytes.len()));
            }
            bytes
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            // Write atomically + chmod 600 on Unix so the key file
            // isn't readable by other local users.
            write_key_file(&path, &bytes)?;
            bytes.to_vec()
        };
        let cipher = XChaCha20Poly1305::new_from_slice(&key_bytes)
            .map_err(|e| SecretError::EncryptFailed(format!("invalid key length: {e}")))?;
        Ok(Self { cipher })
    }

    /// Encrypt `plaintext`. Returns a (ciphertext_b64, nonce_b64)
    /// pair the caller can stash in two TEXT columns.
    ///
    /// # Errors
    /// [`SecretError::EncryptFailed`] on AEAD failure (rare).
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<(String, String), SecretError> {
        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| SecretError::EncryptFailed(e.to_string()))?;
        Ok((B64.encode(&ciphertext), B64.encode(nonce_bytes)))
    }

    /// Inverse of [`encrypt`]. Verifies the auth tag; tampering or
    /// wrong key both surface as [`SecretError::DecryptFailed`].
    pub fn decrypt(&self, ciphertext_b64: &str, nonce_b64: &str) -> Result<Vec<u8>, SecretError> {
        let ciphertext = B64.decode(ciphertext_b64)?;
        let nonce_bytes = B64.decode(nonce_b64)?;
        if nonce_bytes.len() != 24 {
            return Err(SecretError::DecryptFailed);
        }
        let nonce = XNonce::from_slice(&nonce_bytes);
        self.cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| SecretError::DecryptFailed)
    }
}

#[cfg(unix)]
fn write_key_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    std::io::Write::write_all(&mut f, bytes)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn write_key_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // Windows: relies on the default ACL on `<state_dir>` (user
    // profile dir) to keep the key file private. Tighter ACL
    // tweaks are out of scope for v1.
    std::fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt_returns_original_plaintext() {
        let tmp = tempfile::tempdir().unwrap();
        let kr = SecretKeyring::open(tmp.path()).unwrap();
        let plain = b"sk-test-1234567890";
        let (ct, nonce) = kr.encrypt(plain).unwrap();
        let back = kr.decrypt(&ct, &nonce).unwrap();
        assert_eq!(back, plain);
    }

    #[test]
    fn reopen_uses_same_key_so_old_ciphertext_still_decrypts() {
        let tmp = tempfile::tempdir().unwrap();
        let kr1 = SecretKeyring::open(tmp.path()).unwrap();
        let (ct, nonce) = kr1.encrypt(b"persist-me").unwrap();
        drop(kr1);
        let kr2 = SecretKeyring::open(tmp.path()).unwrap();
        let back = kr2.decrypt(&ct, &nonce).unwrap();
        assert_eq!(back, b"persist-me");
    }

    #[test]
    fn ciphertext_with_swapped_byte_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let kr = SecretKeyring::open(tmp.path()).unwrap();
        let (mut ct, nonce) = kr.encrypt(b"tamper").unwrap();
        // Flip a bit by replacing the first base64 char with a
        // different valid one.
        let first = ct.chars().next().unwrap();
        let replacement = if first == 'A' { 'B' } else { 'A' };
        ct.replace_range(..1, &replacement.to_string());
        let err = kr.decrypt(&ct, &nonce).unwrap_err();
        assert!(matches!(
            err,
            SecretError::DecryptFailed | SecretError::Base64(_)
        ));
    }

    #[test]
    fn fresh_state_dir_generates_a_new_key_file() {
        let tmp = tempfile::tempdir().unwrap();
        let key_path = tmp.path().join(KEY_FILENAME);
        assert!(!key_path.exists());
        let _ = SecretKeyring::open(tmp.path()).unwrap();
        assert!(key_path.exists());
        assert_eq!(std::fs::metadata(&key_path).unwrap().len(), 32);
    }
}
