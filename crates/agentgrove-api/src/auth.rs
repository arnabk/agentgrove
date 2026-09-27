//! Optional Google OAuth login + domain restriction.
//!
//! Auth is **opt-in via env**. When [`AuthConfig::from_env`] returns
//! `None` (the default), the server behaves exactly as before: it binds
//! to loopback, trusts the host, and applies no login gate. When the
//! Google client id + secret are configured, every request outside the
//! `/api/auth/*` + `/health` allowlist must present a valid session
//! cookie or receive `401`.
//!
//! ## Flow (server-side Authorization Code)
//!
//! `/api/auth/login` → 302 to Google consent → `/api/auth/callback`
//! exchanges the code for tokens, verifies the id-token via Google's
//! `tokeninfo` endpoint, enforces the domain allowlist on the verified
//! email, and mints a **stateless** session cookie. The OAuth client
//! secret never reaches the browser.
//!
//! ## Stateless session (no DB table)
//!
//! The cookie value is an AEAD-sealed JSON blob
//! (`{email, name, picture, exp}`) produced by the machine-bound
//! [`SecretKeyring`] — the same key that seals provider secrets.
//! Tampering fails decryption → `401`; expiry is checked after
//! decrypt. Single-tenant: any allowed-domain Google account is a full
//! user, no roles. Logout just clears the cookie (revocation before
//! expiry isn't supported by design — the tradeoff the user chose).

use crate::state::AppState;
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::env;

/// Cookie name for the sealed session blob.
const COOKIE: &str = "ag_session";
/// Session lifetime. ponytail: fixed 7 days; make configurable if
/// someone needs shorter-lived sessions.
const SESSION_TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// Google OAuth config, present only when the required env vars are set.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub client_id: String,
    pub client_secret: String,
    /// Allowed email domains (lowercased). Empty = any Google account.
    pub allowed_domains: Vec<String>,
    /// Allowed individual emails (lowercased). Empty = don't restrict by
    /// email (domain check still applies). When non-empty, ONLY these
    /// exact addresses may sign in — tighter than the domain gate.
    pub allowed_emails: Vec<String>,
    /// BE origin — builds the OAuth `redirect_uri` (Google calls back
    /// here, so it must reach `/api/auth/callback`). No trailing slash.
    pub public_url: String,
    /// FE origin to land on after login. Defaults to `public_url`; set
    /// separately in dev where FE (:5173) and BE (:4317) differ.
    pub app_url: String,
}

impl AuthConfig {
    /// Read config from the environment. Returns `None` (auth disabled)
    /// unless BOTH `AGENTGROVE_GOOGLE_CLIENT_ID` and
    /// `AGENTGROVE_GOOGLE_CLIENT_SECRET` are set — so a partial config
    /// never silently half-enables the gate.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let client_id = env::var("AGENTGROVE_GOOGLE_CLIENT_ID").ok()?;
        let client_secret = env::var("AGENTGROVE_GOOGLE_CLIENT_SECRET").ok()?;
        if client_id.trim().is_empty() || client_secret.trim().is_empty() {
            return None;
        }
        let csv_lower = |var: &str| {
            env::var(var)
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        };
        let allowed_domains = csv_lower("AGENTGROVE_AUTH_ALLOWED_DOMAINS");
        let allowed_emails = csv_lower("AGENTGROVE_AUTH_ALLOWED_EMAILS");
        let public_url = env::var("AGENTGROVE_PUBLIC_URL")
            .unwrap_or_else(|_| "http://localhost:4317".to_string())
            .trim_end_matches('/')
            .to_string();
        let app_url = env::var("AGENTGROVE_APP_URL")
            .ok()
            .map(|s| s.trim_end_matches('/').to_string())
            .unwrap_or_else(|| public_url.clone());
        Some(Self {
            client_id,
            client_secret,
            allowed_domains,
            allowed_emails,
            public_url,
            app_url,
        })
    }

    fn redirect_uri(&self) -> String {
        format!("{}/api/auth/callback", self.public_url)
    }

    /// True when `email` may sign in. Email + domain allowlists are
    /// ANDed and each is skipped when empty: the email (if any) must
    /// match an exact address, the domain (if any) must match the part
    /// after `@`. Both empty = any Google account.
    #[must_use]
    pub fn email_allowed(&self, email: &str) -> bool {
        let email = email.to_ascii_lowercase();
        if !self.allowed_emails.is_empty() && !self.allowed_emails.iter().any(|e| e == &email) {
            return false;
        }
        if !self.allowed_domains.is_empty() {
            let dom = match email.rsplit_once('@') {
                Some((_, d)) => d,
                None => return false,
            };
            if !self.allowed_domains.iter().any(|d| d == dom) {
                return false;
            }
        }
        true
    }
}

/// The authenticated identity, sealed into the session cookie.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub picture: String,
    /// Unix expiry (seconds).
    pub exp: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Seal a session into a cookie-safe `ct.nonce` string via the keyring.
fn seal_session(state: &AppState, s: &Session) -> Option<String> {
    let json = serde_json::to_vec(s).ok()?;
    let (ct, nonce) = state.keyring.encrypt(&json).ok()?;
    // base64 (from encrypt) has no '.', so it's a safe separator.
    Some(format!("{ct}.{nonce}"))
}

/// Open a sealed cookie back into a `Session`, rejecting tampering and
/// expiry.
fn open_session(state: &AppState, packed: &str) -> Option<Session> {
    let (ct, nonce) = packed.split_once('.')?;
    let plain = state.keyring.decrypt(ct, nonce).ok()?;
    let s: Session = serde_json::from_slice(&plain).ok()?;
    if s.exp <= now_secs() {
        return None;
    }
    Some(s)
}

/// Pull the session cookie out of a request's `Cookie` header.
fn session_from_headers(state: &AppState, headers: &header::HeaderMap) -> Option<Session> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&format!("{COOKIE}=")) {
            return open_session(state, v);
        }
    }
    None
}

fn set_cookie_header(value: &str, max_age: i64, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{COOKIE}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}{secure}")
}

// ---- Handlers -------------------------------------------------------------

/// `GET /api/auth/config` — tells the FE whether to show a login gate.
/// Always public (never gated), so the login screen can load.
pub async fn config(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "enabled": state.auth.is_some(),
        "provider": "google",
    }))
}

/// `GET /api/auth/me` — the current identity, or 401 when unauthenticated.
/// When auth is disabled, reports the OS user so the FE has a name.
pub async fn me(State(state): State<AppState>, req: Request<Body>) -> Response {
    let Some(_cfg) = state.auth.as_ref() else {
        return Json(serde_json::json!({
            "authenticated": false,
            "auth_enabled": false,
            "email": whoami::username(),
        }))
        .into_response();
    };
    match session_from_headers(&state, req.headers()) {
        Some(s) => Json(serde_json::json!({
            "authenticated": true,
            "auth_enabled": true,
            "email": s.email,
            "name": s.name,
            "picture": s.picture,
        }))
        .into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// `GET /api/auth/login` — redirect to Google's consent screen.
pub async fn login(State(state): State<AppState>) -> Response {
    let Some(cfg) = state.auth.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // CSRF: random state echoed back on the callback via a short-lived
    // cookie. ponytail: single opaque nonce, no PKCE (confidential
    // client already holds the secret); add PKCE if we ever ship a
    // public client.
    let mut b = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    let csrf = base64_url(&b);
    let scope = "openid%20email%20profile";
    let hd = cfg
        .allowed_domains
        .first()
        .map(|d| format!("&hd={d}"))
        .unwrap_or_default();
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code\
         &client_id={cid}&redirect_uri={ru}&scope={scope}&state={csrf}\
         &access_type=online&prompt=select_account{hd}",
        cid = urlencode(&cfg.client_id),
        ru = urlencode(&cfg.redirect_uri()),
    );
    let secure = cfg.public_url.starts_with("https");
    let cookie = format!(
        "ag_csrf={csrf}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600{}",
        if secure { "; Secure" } else { "" }
    );
    (
        StatusCode::FOUND,
        [(header::SET_COOKIE, cookie), (header::LOCATION, url)],
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    code: String,
    #[serde(default)]
    state: String,
}

/// `GET /api/auth/callback` — exchange code, verify, enforce domain,
/// mint the session cookie, then redirect into the app.
pub async fn callback(
    State(state): State<AppState>,
    Query(q): Query<CallbackQuery>,
    req: Request<Body>,
) -> Response {
    let Some(cfg) = state.auth.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // CSRF check: the `state` param must match the ag_csrf cookie.
    let csrf_cookie = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| {
            raw.split(';')
                .filter_map(|p| p.trim().strip_prefix("ag_csrf="))
                .map(str::to_string)
                .next()
        });
    if q.code.is_empty() || csrf_cookie.as_deref() != Some(q.state.as_str()) {
        return (StatusCode::BAD_REQUEST, "invalid oauth state").into_response();
    }

    // Exchange the authorization code for tokens.
    let client = reqwest::Client::new();
    let token_res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", q.code.as_str()),
            ("client_id", cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("redirect_uri", cfg.redirect_uri().as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await;
    let id_token = match token_res {
        Ok(r) if r.status().is_success() => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("id_token").and_then(|x| x.as_str()).map(String::from)),
        Ok(r) => {
            tracing::warn!(status = %r.status(), "google token exchange failed");
            None
        }
        Err(e) => {
            tracing::warn!(error = %e, "google token exchange error");
            None
        }
    };
    let Some(id_token) = id_token else {
        return (StatusCode::BAD_GATEWAY, "token exchange failed").into_response();
    };

    // Verify the id-token via Google's tokeninfo endpoint (validates the
    // signature + audience server-side; leanest correct check without an
    // offline JWKS/JWT dependency). ponytail: one HTTP call per login;
    // swap to cached JWKS verification if login volume ever matters.
    let info = client
        .get("https://oauth2.googleapis.com/tokeninfo")
        .query(&[("id_token", id_token.as_str())])
        .send()
        .await
        .ok();
    let claims = match info {
        Some(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
        _ => None,
    };
    let Some(claims) = claims else {
        return (StatusCode::BAD_GATEWAY, "token verification failed").into_response();
    };
    // Audience must be our client id, and the email must be verified.
    if claims.get("aud").and_then(|v| v.as_str()) != Some(cfg.client_id.as_str()) {
        return (StatusCode::UNAUTHORIZED, "audience mismatch").into_response();
    }
    let email = claims.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let verified = claims
        .get("email_verified")
        .map(|v| v.as_str() == Some("true") || v.as_bool() == Some(true))
        .unwrap_or(false);
    if email.is_empty() || !verified || !cfg.email_allowed(email) {
        tracing::warn!(email, "auth: account not allowed");
        let to = format!("{}/?auth_error=forbidden", cfg.app_url);
        return (StatusCode::FOUND, [(header::LOCATION, to)]).into_response();
    }

    let session = Session {
        email: email.to_string(),
        name: claims
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        picture: claims
            .get("picture")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        exp: now_secs() + SESSION_TTL_SECS,
    };
    let Some(sealed) = seal_session(&state, &session) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "session seal failed").into_response();
    };
    let secure = cfg.public_url.starts_with("https");
    let set = set_cookie_header(&sealed, SESSION_TTL_SECS as i64, secure);
    // Clear the CSRF cookie and land the user in the app. AppendHeaders
    // preserves BOTH Set-Cookie headers (a plain tuple array would
    // collapse the duplicate key, dropping the session cookie).
    (
        StatusCode::FOUND,
        axum::response::AppendHeaders([
            (header::SET_COOKIE, set),
            (
                header::SET_COOKIE,
                "ag_csrf=; HttpOnly; Path=/; Max-Age=0".to_string(),
            ),
            (header::LOCATION, cfg.app_url.clone()),
        ]),
    )
        .into_response()
}

/// `POST /api/auth/logout` — clear the session cookie.
pub async fn logout(State(state): State<AppState>) -> Response {
    let secure = state
        .auth
        .as_ref()
        .map(|c| c.public_url.starts_with("https"))
        .unwrap_or(false);
    let cleared = set_cookie_header("", 0, secure);
    (StatusCode::NO_CONTENT, [(header::SET_COOKIE, cleared)]).into_response()
}

/// Axum middleware: when auth is enabled, require a valid session for
/// everything except the auth endpoints, the health check, and CORS
/// preflight. When disabled, pass through unchanged.
pub async fn guard(State(state): State<AppState>, req: Request<Body>, next: Next) -> Response {
    let Some(_cfg) = state.auth.as_ref() else {
        return next.run(req).await;
    };
    let path = req.uri().path();
    // Allowlist: auth endpoints (so login can happen), health, and
    // OPTIONS preflight (no cookies on preflight).
    if req.method() == axum::http::Method::OPTIONS
        || path == "/health"
        || path.starts_with("/api/auth/")
    {
        return next.run(req).await;
    }
    if session_from_headers(&state, req.headers()).is_some() {
        return next.run(req).await;
    }
    StatusCode::UNAUTHORIZED.into_response()
}

// ---- tiny url helpers (avoid a new dep) -----------------------------------

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn base64_url(b: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg2(domains: &[&str], emails: &[&str]) -> AuthConfig {
        AuthConfig {
            client_id: "cid".into(),
            client_secret: "sec".into(),
            allowed_domains: domains.iter().map(|d| d.to_string()).collect(),
            allowed_emails: emails.iter().map(|e| e.to_string()).collect(),
            public_url: "https://app.example.com".into(),
            app_url: "https://app.example.com".into(),
        }
    }
    fn cfg(domains: &[&str]) -> AuthConfig {
        cfg2(domains, &[])
    }

    #[test]
    fn empty_allowlist_admits_any_domain() {
        let c = cfg(&[]);
        assert!(c.email_allowed("anyone@gmail.com"));
        assert!(c.email_allowed("x@whatever.io"));
    }

    #[test]
    fn domain_allowlist_matches_case_insensitively_and_rejects_others() {
        let c = cfg(&["ranartech.com", "theysaid.io"]);
        assert!(c.email_allowed("a@ranartech.com"));
        assert!(c.email_allowed("B@TheySaid.io"));
        assert!(!c.email_allowed("evil@gmail.com"));
        assert!(!c.email_allowed("no-at-sign"));
    }

    #[test]
    fn email_allowlist_restricts_to_exact_addresses() {
        // Single-email gate: only arnab@theysaid.io, case-insensitive.
        let c = cfg2(&["theysaid.io"], &["arnab@theysaid.io"]);
        assert!(c.email_allowed("arnab@theysaid.io"));
        assert!(c.email_allowed("Arnab@TheySaid.io"));
        // Same allowed domain but not the listed address → rejected.
        assert!(!c.email_allowed("someone@theysaid.io"));
        // Listed email but wrong domain can't happen here; a mismatched
        // domain+email combo still fails the domain gate.
        let c2 = cfg2(&["theysaid.io"], &["arnab@other.com"]);
        assert!(!c2.email_allowed("arnab@other.com"));
    }

    #[test]
    fn redirect_uri_is_public_url_plus_callback() {
        assert_eq!(
            cfg(&[]).redirect_uri(),
            "https://app.example.com/api/auth/callback"
        );
    }

    #[test]
    fn urlencode_escapes_reserved() {
        assert_eq!(urlencode("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(urlencode("safe-._~"), "safe-._~");
    }

    // Cookie seal/open round-trip against a real keyring. Builds a
    // minimal AppState-like keyring holder; we call the free helpers
    // directly via a tiny shim rather than constructing full AppState.
    fn keyring() -> agentgrove_store::SecretKeyring {
        let tmp = tempfile::tempdir().unwrap();
        agentgrove_store::SecretKeyring::open(tmp.path()).unwrap()
    }

    fn seal_with(kr: &agentgrove_store::SecretKeyring, s: &Session) -> String {
        let json = serde_json::to_vec(s).unwrap();
        let (ct, nonce) = kr.encrypt(&json).unwrap();
        format!("{ct}.{nonce}")
    }

    fn open_with(kr: &agentgrove_store::SecretKeyring, packed: &str) -> Option<Session> {
        let (ct, nonce) = packed.split_once('.')?;
        let plain = kr.decrypt(ct, nonce).ok()?;
        let s: Session = serde_json::from_slice(&plain).ok()?;
        if s.exp <= now_secs() {
            return None;
        }
        Some(s)
    }

    #[test]
    fn session_cookie_roundtrips() {
        let kr = keyring();
        let s = Session {
            email: "a@ranartech.com".into(),
            name: "A".into(),
            picture: String::new(),
            exp: now_secs() + 60,
        };
        let packed = seal_with(&kr, &s);
        let back = open_with(&kr, &packed).unwrap();
        assert_eq!(back.email, "a@ranartech.com");
    }

    #[test]
    fn tampered_cookie_is_rejected() {
        let kr = keyring();
        let s = Session {
            email: "a@ranartech.com".into(),
            name: String::new(),
            picture: String::new(),
            exp: now_secs() + 60,
        };
        let mut packed = seal_with(&kr, &s);
        let c = packed.chars().next().unwrap();
        packed.replace_range(..1, if c == 'A' { "B" } else { "A" });
        assert!(open_with(&kr, &packed).is_none());
    }

    #[test]
    fn expired_cookie_is_rejected() {
        let kr = keyring();
        let s = Session {
            email: "a@ranartech.com".into(),
            name: String::new(),
            picture: String::new(),
            exp: now_secs() - 1,
        };
        let packed = seal_with(&kr, &s);
        assert!(open_with(&kr, &packed).is_none());
    }
}
