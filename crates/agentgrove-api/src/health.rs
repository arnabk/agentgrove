//! Health probe.

use axum::Json;
use serde::Serialize;

/// Body returned by `/health`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Health {
    /// Static literal `"ok"` when the server has started.
    pub status: &'static str,
    /// Crate version (matches binary).
    pub version: &'static str,
}

/// Health handler. Always returns `200 OK` once Axum is serving requests.
pub async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}
