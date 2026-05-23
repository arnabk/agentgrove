//! Per-provider configuration + encrypted API key store.
//!
//! Wraps the `provider_secrets` table and the [`SecretKeyring`] in
//! one repo so handlers can read/write a typed `ProviderSecret`
//! without ever touching the cipher directly. The `api_key` field
//! crosses the API boundary as plain text (over loopback HTTP, with
//! no network exposure); the BE only stores it as ciphertext.
//!
//! Model selection is intentionally NOT stored here — it belongs at
//! chat-creation time, sourced from the provider's static
//! `ProviderDescriptor` (see migration 0009).

use crate::db::DbPool;
use crate::secret::{SecretError, SecretKeyring};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A decoded provider configuration row. `api_key` is `None` when the
/// user has set `base_url` but not yet pasted a key, OR when the
/// row's ciphertext failed to decrypt (logged + the caller is
/// expected to treat the provider as unconfigured).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSecret {
    /// Stable id (e.g. `"acme"`).
    pub provider_id: String,
    /// Base URL the FE / agents talk to (e.g. `http://localhost:20128/v1`).
    pub base_url: String,
    /// Plaintext API key. Always `Some` after a successful PUT; may
    /// be `None` on a GET if the user hasn't supplied one yet.
    pub api_key: Option<String>,
}

/// Same as [`ProviderSecret`] but with the API key replaced by a
/// `has_api_key: bool` flag — what the FE actually reads (we never
/// echo keys back over HTTP).
#[derive(Debug, Clone, Serialize)]
pub struct ProviderSecretSummary {
    /// Stable provider id.
    pub provider_id: String,
    /// Base URL.
    pub base_url: String,
    /// True iff a non-empty API key is stored. The key itself is
    /// never returned over HTTP.
    pub has_api_key: bool,
}

impl From<&ProviderSecret> for ProviderSecretSummary {
    fn from(s: &ProviderSecret) -> Self {
        Self {
            provider_id: s.provider_id.clone(),
            base_url: s.base_url.clone(),
            has_api_key: s.api_key.is_some(),
        }
    }
}

/// Errors raised by [`ProviderSecretRepo`].
#[derive(Debug, Error)]
pub enum ProviderSecretError {
    /// Underlying sqlx error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    /// Crypto error (cipher missing, bad key, tampered ciphertext).
    #[error("secret store: {0}")]
    Secret(#[from] SecretError),
}

/// Repository over `provider_secrets`. Cheap to clone (Arc-backed).
#[derive(Clone)]
pub struct ProviderSecretRepo {
    pool: DbPool,
    keyring: SecretKeyring,
}

impl std::fmt::Debug for ProviderSecretRepo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderSecretRepo").finish_non_exhaustive()
    }
}

impl ProviderSecretRepo {
    /// Construct a new repo backed by `pool` + `keyring`. The
    /// keyring is typically built once by AppState from
    /// `<state_dir>/secrets.key`.
    #[must_use]
    pub fn new(pool: DbPool, keyring: SecretKeyring) -> Self {
        Self { pool, keyring }
    }

    /// Fetch a single provider's config. Returns `None` if no row
    /// exists. A row with a corrupt ciphertext (e.g. secrets.key was
    /// rotated) is returned with `api_key=None` so the caller can
    /// surface a re-paste prompt.
    pub async fn get(
        &self,
        provider_id: &str,
    ) -> Result<Option<ProviderSecret>, ProviderSecretError> {
        let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT provider_id, base_url, ciphertext_b64, nonce_b64 \
             FROM provider_secrets WHERE provider_id = ?1",
        )
        .bind(provider_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some((id, base_url, ct, nonce)) = row else {
            return Ok(None);
        };
        let api_key = match (ct, nonce) {
            (Some(c), Some(n)) => match self.keyring.decrypt(&c, &n) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(s) => Some(s),
                    Err(_) => {
                        tracing::warn!(
                            provider_id,
                            "decrypted key is not valid UTF-8; treating as unset"
                        );
                        None
                    }
                },
                Err(e) => {
                    tracing::warn!(provider_id, error = %e, "ciphertext failed to decrypt; treating as unset");
                    None
                }
            },
            _ => None,
        };
        Ok(Some(ProviderSecret {
            provider_id: id,
            base_url,
            api_key,
        }))
    }

    /// Insert or update a provider's config.
    ///
    /// `api_key` semantics:
    ///   - `Some(non_empty)` → encrypt + persist.
    ///   - `Some("")` → clear the stored key (user wants to drop it).
    ///   - `None` → leave the existing key untouched (only updates
    ///     `base_url`).
    pub async fn put(
        &self,
        provider_id: &str,
        base_url: &str,
        api_key: Option<&str>,
    ) -> Result<(), ProviderSecretError> {
        let now_ms = Utc::now().timestamp_millis();
        let (ct, nonce) = match api_key {
            Some(k) if !k.is_empty() => {
                let (c, n) = self.keyring.encrypt(k.as_bytes())?;
                (Some(Some(c)), Some(Some(n)))
            }
            Some(_) => (Some(None), Some(None)),
            None => (None, None),
        };

        // Two branches: when `api_key` is None we don't want to
        // overwrite the existing ciphertext columns, so we omit them
        // from the UPDATE.
        match (ct, nonce) {
            (Some(c), Some(n)) => {
                sqlx::query(
                    "INSERT INTO provider_secrets \
                     (provider_id, base_url, ciphertext_b64, nonce_b64, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5) \
                     ON CONFLICT (provider_id) DO UPDATE SET \
                       base_url = excluded.base_url, \
                       ciphertext_b64 = excluded.ciphertext_b64, \
                       nonce_b64 = excluded.nonce_b64, \
                       updated_at = excluded.updated_at",
                )
                .bind(provider_id)
                .bind(base_url)
                .bind(&c)
                .bind(&n)
                .bind(now_ms)
                .execute(&self.pool)
                .await?;
            }
            _ => {
                sqlx::query(
                    "INSERT INTO provider_secrets \
                     (provider_id, base_url, ciphertext_b64, nonce_b64, updated_at) \
                     VALUES (?1, ?2, NULL, NULL, ?3) \
                     ON CONFLICT (provider_id) DO UPDATE SET \
                       base_url = excluded.base_url, \
                       updated_at = excluded.updated_at",
                )
                .bind(provider_id)
                .bind(base_url)
                .bind(now_ms)
                .execute(&self.pool)
                .await?;
            }
        }
        Ok(())
    }

    /// Delete a provider's config (e.g. user disconnected the
    /// provider entirely). Returns whether a row was removed.
    pub async fn delete(&self, provider_id: &str) -> Result<bool, ProviderSecretError> {
        let res = sqlx::query("DELETE FROM provider_secrets WHERE provider_id = ?1")
            .bind(provider_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }

    /// List every configured provider (without API keys). Used by
    /// the FE Settings → Providers tab to show all known configs in
    /// one round-trip.
    pub async fn list_summaries(&self) -> Result<Vec<ProviderSecretSummary>, ProviderSecretError> {
        let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT provider_id, base_url, ciphertext_b64 \
             FROM provider_secrets ORDER BY provider_id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(provider_id, base_url, ct)| ProviderSecretSummary {
                provider_id,
                base_url,
                has_api_key: ct.is_some(),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_pool, run_migrations};

    async fn fixture() -> (tempfile::TempDir, ProviderSecretRepo) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = open_pool(tmp.path()).await.unwrap();
        run_migrations(&pool).await.unwrap();
        let keyring = SecretKeyring::open(tmp.path()).unwrap();
        let repo = ProviderSecretRepo::new(pool, keyring);
        (tmp, repo)
    }

    #[tokio::test]
    async fn put_then_get_returns_plaintext_key() {
        let (_tmp, repo) = fixture().await;
        repo.put("acme", "http://localhost:20128/v1", Some("sk-xxx"))
            .await
            .unwrap();
        let got = repo.get("acme").await.unwrap().unwrap();
        assert_eq!(got.base_url, "http://localhost:20128/v1");
        assert_eq!(got.api_key.as_deref(), Some("sk-xxx"));
    }

    #[tokio::test]
    async fn put_with_no_api_key_preserves_existing_key() {
        let (_tmp, repo) = fixture().await;
        repo.put("acme", "http://a", Some("sk-1")).await.unwrap();
        // Update base_url without changing the key.
        repo.put("acme", "http://b", None).await.unwrap();
        let got = repo.get("acme").await.unwrap().unwrap();
        assert_eq!(got.base_url, "http://b");
        assert_eq!(got.api_key.as_deref(), Some("sk-1"));
    }

    #[tokio::test]
    async fn put_with_empty_string_key_clears_existing_key() {
        let (_tmp, repo) = fixture().await;
        repo.put("acme", "http://a", Some("sk-1")).await.unwrap();
        repo.put("acme", "http://a", Some("")).await.unwrap();
        let got = repo.get("acme").await.unwrap().unwrap();
        assert_eq!(got.api_key, None);
    }

    #[tokio::test]
    async fn list_summaries_omits_keys() {
        let (_tmp, repo) = fixture().await;
        repo.put("acme", "http://a", Some("sk-1")).await.unwrap();
        repo.put("acme2", "http://b", None).await.unwrap();
        let sums = repo.list_summaries().await.unwrap();
        assert_eq!(sums.len(), 2);
        let nine = sums.iter().find(|s| s.provider_id == "acme").unwrap();
        assert!(nine.has_api_key);
        let oai = sums.iter().find(|s| s.provider_id == "acme2").unwrap();
        assert!(!oai.has_api_key);
    }
}
