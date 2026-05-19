//! Bearer-token authentication middleware.
//!
//! Auth is **opt-in**. When `AppState.token` is `None` (the default for
//! local dev), all routes are open. When a token is configured, every
//! protected route requires `Authorization: Bearer <token>` and the
//! token is compared in constant time to avoid timing oracles.

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};

use crate::state::AppState;

/// Axum middleware that enforces `Authorization: Bearer <token>` on
/// protected routes when a token is configured. Pass-through otherwise.
pub async fn require_bearer(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let Some(expected) = state.token.as_deref() else {
        // Auth disabled — pass through.
        return Ok(next.run(req).await);
    };

    let header_value = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let presented = header_value
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if !constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(req).await)
}

/// Constant-time equality check. Returns `false` on length mismatch.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn equal_inputs_compare_equal() {
        assert!(constant_time_eq(b"abc", b"abc"));
    }

    #[test]
    fn different_inputs_compare_unequal() {
        assert!(!constant_time_eq(b"abc", b"abd"));
    }

    #[test]
    fn different_length_compares_unequal() {
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn empty_inputs_compare_equal() {
        assert!(constant_time_eq(b"", b""));
    }
}
