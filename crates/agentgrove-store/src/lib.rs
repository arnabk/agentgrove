//! Persistence layer for AgentGrove.
//!
//! M0 scope: blob store on disk. SQLite schema and repositories land in M1.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod blob;

pub use blob::{BlobStore, Sha256};
