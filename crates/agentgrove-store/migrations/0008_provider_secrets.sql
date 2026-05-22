-- Per-provider configuration + encrypted API key.
--
-- Each row stores everything we need to talk to a configured HTTP
-- provider: the base URL, the user's preferred default model, and
-- the API key encrypted at rest with a machine-bound XChaCha20-
-- Poly1305 key (see `agentgrove-store::secret`). The encryption
-- key itself lives at `<state_dir>/secrets.key` (chmod 600);
-- losing that file invalidates every row's ciphertext.
--
-- Subprocess-style providers (Claude, opencode) DO NOT use this
-- table — they rely on their CLI's own auth (env vars, login
-- cookies, etc.). Only HTTP-API providers (9router today, future
-- OpenAI-compat aggregators) need a row here.
--
-- Layout notes:
--   * `provider_id` is the stable id from `agentgrove_agents::ProviderId`
--     (e.g. "9router"). PRIMARY KEY ⇒ exactly one config per provider.
--   * `ciphertext_b64` + `nonce_b64` are base64-encoded payload halves
--     so the column type stays TEXT (compat with `STRICT` mode without
--     a BLOB column). Both fields are NULL when the user has set
--     base_url + default_model but not yet pasted a key.
--   * `default_model` is the FE's seed selection for new chats —
--     not authoritative, just convenient.

CREATE TABLE provider_secrets (
    provider_id    TEXT    PRIMARY KEY NOT NULL,
    base_url       TEXT    NOT NULL,
    default_model  TEXT,
    ciphertext_b64 TEXT,
    nonce_b64      TEXT,
    updated_at     INTEGER NOT NULL
) STRICT;
