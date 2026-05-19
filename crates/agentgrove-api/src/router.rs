//! Axum router and shared application state.

use axum::{middleware, routing::get, Router};
use std::sync::Arc;

use crate::{auth::require_bearer, health::health};

/// Shared application state.
#[derive(Debug, Clone)]
pub struct AppState {
    /// Bearer token required for protected routes.
    pub token: Arc<String>,
}

impl AppState {
    /// Build state with a bearer token.
    #[must_use]
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: Arc::new(token.into()),
        }
    }
}

/// Construct the application router. Used by both the binary and tests.
pub fn build_router(state: AppState) -> Router {
    // Public routes (no auth).
    let public = Router::new().route("/health", get(health));

    // Protected routes (auth middleware applied).
    let protected =
        Router::new()
            .route("/whoami", get(whoami))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer,
            ));

    Router::new()
        .merge(public)
        .merge(protected)
        .with_state(state)
}

async fn whoami() -> &'static str {
    "authenticated"
}
