//! Ticket-integration CLI/API-key token store.
//!
//! Wraps the `integration_tokens` table and the [`SecretKeyring`] so
//! handlers can read/write typed [`IntegrationToken`]s without touching
//! the cipher directly. Access/refresh tokens cross the API boundary as
//! plain text (over loopback HTTP, no network exposure); the BE only
//! stores them as ciphertext.
//!
//! Mirrors [`crate::provider_secret`] but with one difference in the
//! at-rest layout: instead of two columns per secret we pack the
//! `<ciphertext_b64>.<nonce_b64>` pair into a single `*_enc` TEXT
//! column, keeping the table schema the ticket asked for.

use crate::db::DbPool;
use crate::secret::{SecretError, SecretKeyring};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A decoded integration token row. `access_token` is always present
/// after a successful `save_token`; the whole row is returned as `None`
/// by `get_token` when the ciphertext fails to decrypt (logged, so the
/// caller treats the provider as disconnected).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationToken {
    /// Provider id (`"github"`, `"gitlab"`, `"clickup"`).
    pub provider: String,
    /// Plaintext access token (CLI session or API key).
    pub access_token: String,
    /// Plaintext refresh token, when the provider issues one.
    pub refresh_token: Option<String>,
    /// Token type (defaults to `"Bearer"`).
    pub token_type: Option<String>,
    /// Granted scope string.
    pub scope: Option<String>,
    /// Authenticated user's display name.
    pub user_name: Option<String>,
    /// Authenticated user's id on the provider.
    pub user_id: Option<String>,
    /// Expiry as unix epoch ms, when known.
    pub expires_at: Option<i64>,
}

/// Token-free view of a connection — what the FE reads to render the
/// Settings → Integrations tab. Never carries any token material.
#[derive(Debug, Clone, Serialize)]
pub struct IntegrationSummary {
    /// Provider id.
    pub provider: String,
    /// Authenticated user's display name, when connected.
    pub user_name: Option<String>,
    /// Authenticated user's id on the provider, when connected.
    pub user_id: Option<String>,
    /// True iff a decryptable token is stored.
    pub connected: bool,
}

/// Errors raised by [`IntegrationRepo`].
#[derive(Debug, Error)]
pub enum IntegrationError {
    /// Underlying sqlx error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    /// Crypto error (cipher missing, bad key, tampered ciphertext).
    #[error("secret store: {0}")]
    Secret(#[from] SecretError),
}

/// Row tuple shape returned by `SELECT` against `integration_tokens`
/// (all columns except timestamps, in query order).
type TokenRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

/// Repository over `integration_tokens`. Cheap to clone (Arc-backed
/// pool + keyring).
#[derive(Clone)]
pub struct IntegrationRepo {
    pool: DbPool,
    keyring: SecretKeyring,
}

impl std::fmt::Debug for IntegrationRepo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntegrationRepo").finish_non_exhaustive()
    }
}

impl IntegrationRepo {
    /// Construct a new repo backed by `pool` + `keyring`. The keyring is
    /// typically built once by AppState from `<state_dir>/secrets.key`.
    #[must_use]
    pub fn new(pool: DbPool, keyring: SecretKeyring) -> Self {
        Self { pool, keyring }
    }

    /// Encrypt a plaintext secret into the packed `ct.nonce` column
    /// form.
    fn seal(&self, plaintext: &str) -> Result<String, IntegrationError> {
        let (ct, nonce) = self.keyring.encrypt(plaintext.as_bytes())?;
        Ok(format!("{ct}.{nonce}"))
    }

    /// Inverse of [`seal`]: split the packed column and decrypt. Returns
    /// `None` (logged) on any malformed/undecryptable value so a rotated
    /// key surfaces as "disconnected" rather than a hard error.
    fn open_sealed(&self, provider: &str, packed: &str) -> Option<String> {
        let Some((ct, nonce)) = packed.split_once('.') else {
            tracing::warn!(
                provider,
                "sealed token missing nonce separator; treating as unset"
            );
            return None;
        };
        match self.keyring.decrypt(ct, nonce) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(s) => Some(s),
                Err(_) => {
                    tracing::warn!(
                        provider,
                        "decrypted token is not valid UTF-8; treating as unset"
                    );
                    None
                }
            },
            Err(e) => {
                tracing::warn!(provider, error = %e, "token ciphertext failed to decrypt; treating as unset");
                None
            }
        }
    }

    /// Insert or update a provider's token bundle. Encrypts the access
    /// token (and refresh token, when present) before persisting.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_token(
        &self,
        provider: &str,
        access_token: &str,
        refresh_token: Option<&str>,
        token_type: Option<&str>,
        scope: Option<&str>,
        user_name: Option<&str>,
        user_id: Option<&str>,
        expires_at: Option<i64>,
    ) -> Result<(), IntegrationError> {
        let now_ms = Utc::now().timestamp_millis();
        let access_enc = self.seal(access_token)?;
        let refresh_enc = match refresh_token {
            Some(t) if !t.is_empty() => Some(self.seal(t)?),
            _ => None,
        };
        sqlx::query(
            "INSERT INTO integration_tokens \
             (provider, access_token_enc, refresh_token_enc, token_type, scope, \
              user_name, user_id, expires_at, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) \
             ON CONFLICT (provider) DO UPDATE SET \
               access_token_enc = excluded.access_token_enc, \
               refresh_token_enc = excluded.refresh_token_enc, \
               token_type = excluded.token_type, \
               scope = excluded.scope, \
               user_name = excluded.user_name, \
               user_id = excluded.user_id, \
               expires_at = excluded.expires_at, \
               updated_at = excluded.updated_at",
        )
        .bind(provider)
        .bind(&access_enc)
        .bind(&refresh_enc)
        .bind(token_type)
        .bind(scope)
        .bind(user_name)
        .bind(user_id)
        .bind(expires_at)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Fetch + decrypt a provider's token. Returns `None` when no row
    /// exists OR when the access token can't be decrypted (rotated key).
    pub async fn get_token(
        &self,
        provider: &str,
    ) -> Result<Option<IntegrationToken>, IntegrationError> {
        let row: Option<TokenRow> = sqlx::query_as(
            "SELECT provider, access_token_enc, refresh_token_enc, token_type, scope, \
                    user_name, user_id, expires_at \
             FROM integration_tokens WHERE provider = ?1",
        )
        .bind(provider)
        .fetch_optional(&self.pool)
        .await?;
        let Some((
            provider,
            access_enc,
            refresh_enc,
            token_type,
            scope,
            user_name,
            user_id,
            expires_at,
        )) = row
        else {
            return Ok(None);
        };
        let Some(access_token) = self.open_sealed(&provider, &access_enc) else {
            return Ok(None);
        };
        let refresh_token = refresh_enc
            .as_deref()
            .and_then(|packed| self.open_sealed(&provider, packed));
        Ok(Some(IntegrationToken {
            provider,
            access_token,
            refresh_token,
            token_type,
            scope,
            user_name,
            user_id,
            expires_at,
        }))
    }

    /// Delete a provider's token row (disconnect). Returns whether a row
    /// was removed.
    pub async fn delete_token(&self, provider: &str) -> Result<bool, IntegrationError> {
        let res = sqlx::query("DELETE FROM integration_tokens WHERE provider = ?1")
            .bind(provider)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }

    /// List every stored connection (no tokens). `connected` reflects
    /// whether a row exists — the FE uses it to render connect/disconnect
    /// state in one round-trip.
    pub async fn list_connections(&self) -> Result<Vec<IntegrationSummary>, IntegrationError> {
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT provider, user_name, user_id \
             FROM integration_tokens ORDER BY provider ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(provider, user_name, user_id)| IntegrationSummary {
                provider,
                user_name,
                user_id,
                connected: true,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_pool, run_migrations};

    async fn fixture() -> (tempfile::TempDir, IntegrationRepo) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = open_pool(tmp.path()).await.unwrap();
        run_migrations(&pool).await.unwrap();
        let keyring = SecretKeyring::open(tmp.path()).unwrap();
        let repo = IntegrationRepo::new(pool, keyring);
        (tmp, repo)
    }

    #[tokio::test]
    async fn save_then_get_returns_plaintext_tokens() {
        let (_tmp, repo) = fixture().await;
        repo.save_token(
            "github",
            "gho_access",
            Some("ghr_refresh"),
            Some("Bearer"),
            Some("repo"),
            Some("Octocat"),
            Some("583231"),
            Some(1_700_000_000_000),
        )
        .await
        .unwrap();
        let got = repo.get_token("github").await.unwrap().unwrap();
        assert_eq!(got.access_token, "gho_access");
        assert_eq!(got.refresh_token.as_deref(), Some("ghr_refresh"));
        assert_eq!(got.token_type.as_deref(), Some("Bearer"));
        assert_eq!(got.scope.as_deref(), Some("repo"));
        assert_eq!(got.user_name.as_deref(), Some("Octocat"));
        assert_eq!(got.user_id.as_deref(), Some("583231"));
        assert_eq!(got.expires_at, Some(1_700_000_000_000));
    }

    #[tokio::test]
    async fn save_upserts_and_clears_refresh_when_absent() {
        let (_tmp, repo) = fixture().await;
        repo.save_token("clickup", "a1", Some("r1"), None, None, None, None, None)
            .await
            .unwrap();
        repo.save_token("clickup", "a2", None, None, None, Some("Jane"), None, None)
            .await
            .unwrap();
        let got = repo.get_token("clickup").await.unwrap().unwrap();
        assert_eq!(got.access_token, "a2");
        assert_eq!(got.refresh_token, None);
        assert_eq!(got.user_name.as_deref(), Some("Jane"));
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let (_tmp, repo) = fixture().await;
        repo.save_token("github", "a", None, None, None, None, None, None)
            .await
            .unwrap();
        assert!(repo.delete_token("github").await.unwrap());
        assert!(repo.get_token("github").await.unwrap().is_none());
        assert!(!repo.delete_token("github").await.unwrap());
    }

    #[tokio::test]
    async fn list_connections_omits_tokens() {
        let (_tmp, repo) = fixture().await;
        repo.save_token(
            "github",
            "a",
            None,
            None,
            None,
            Some("Octocat"),
            Some("1"),
            None,
        )
        .await
        .unwrap();
        repo.save_token("clickup", "b", None, None, None, None, None, None)
            .await
            .unwrap();
        let conns = repo.list_connections().await.unwrap();
        assert_eq!(conns.len(), 2);
        let gh = conns.iter().find(|c| c.provider == "github").unwrap();
        assert!(gh.connected);
        assert_eq!(gh.user_name.as_deref(), Some("Octocat"));
    }
}
