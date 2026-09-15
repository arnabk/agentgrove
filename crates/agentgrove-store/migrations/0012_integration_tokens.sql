-- OAuth / CLI-auth tokens for ticket-integration providers.
--
-- One row per provider (github / gitlab / clickup). Tokens are stored
-- encrypted at rest with the same machine-bound XChaCha20-Poly1305
-- keyring used by `provider_secrets` (see `agentgrove-store::secret`).
-- The encrypted columns hold a `<ciphertext_b64>.<nonce_b64>` pair so a
-- single TEXT column round-trips both halves the keyring needs to
-- decrypt.
--
-- GitLab typically stores no token here (it relies on the `glab` CLI's
-- own auth); the row is only written when a provider actually completes
-- an OAuth exchange.

CREATE TABLE IF NOT EXISTS integration_tokens (
    provider          TEXT    NOT NULL,       -- 'github', 'gitlab', 'clickup'
    access_token_enc  TEXT    NOT NULL,       -- encrypted OAuth access token
    refresh_token_enc TEXT,                   -- encrypted refresh token (nullable)
    token_type        TEXT    DEFAULT 'Bearer',
    scope             TEXT,
    user_name         TEXT,                   -- the authenticated user's display name
    user_id           TEXT,                   -- the authenticated user's id on the provider
    expires_at        INTEGER,                -- unix epoch ms, nullable
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (provider)
);
