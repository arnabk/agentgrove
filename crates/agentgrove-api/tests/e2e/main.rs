//! L4 BE endpoint E2E tests.
//!
//! `BeHarness` boots the real Axum router on an ephemeral loopback port
//! using `tokio::net::TcpListener`. Tests hit every route as a real HTTP
//! client. WS coverage is added in M1.
//!
//! Route inventory is enforced: each route in the router must be exercised
//! by at least one test. The inventory itself is committed in
//! `tests/e2e/coverage.txt`.

mod support;

mod health_route;
mod route_inventory;
mod whoami_route;
