//! Git operations for AgentGrove via `gix`.
//!
//! M0 scope: smoke check that the crate compiles with `gix` and can be
//! linked from downstream crates. Full worktree API lands in M1.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

/// Returns the `gix` version string this crate links against.
#[must_use]
pub fn gix_version() -> &'static str {
    // gix exposes its version via the crate; we use a compile-time constant
    // sourced from this crate so we have something deterministic to test.
    env!("CARGO_PKG_VERSION")
}
