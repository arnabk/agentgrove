//! HTTP + WS API layer for AgentGrove.
//!
//! M0 scope: `/health` route, bearer-token auth middleware, route builder
//! consumed by both the binary and the L4 endpoint test harness.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod auth;
pub mod health;
pub mod router;

pub use router::{build_router, AppState};
