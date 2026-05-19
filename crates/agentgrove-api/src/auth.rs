//! Bearer-token authentication middleware.
//!
//! The token is configured at startup. All routes other than `/health` and
//! `/openapi.json` (later) require `Authorization: Bearer <token>`.
//!
//! Constant-time comparison is used to avoid timing oracles.

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};

use crate::router::AppState;

/// Axum middleware that enforces `Authorization: Bearer <token>` on
/// protected routes.
pub async fn require_bearer(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let header_value = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let presented = header_value
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if !constant_time_eq(presented.as_bytes(), state.token.as_bytes()) {
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
