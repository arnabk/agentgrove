//! Core error type used across crates.

use thiserror::Error;

/// AgentGrove error type.
#[derive(Debug, Error)]
pub enum Error {
    /// Invalid input from a caller (validation failure, malformed value).
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// Requested entity does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// A precondition (state, version, ownership) failed.
    #[error("conflict: {0}")]
    Conflict(String),

    /// Unexpected internal error. Should be rare and reported.
    #[error("internal error: {0}")]
    Internal(String),
}

/// Crate-wide result alias.
pub type Result<T> = std::result::Result<T, Error>;
