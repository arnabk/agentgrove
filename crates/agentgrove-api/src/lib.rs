//! HTTP + WS API layer for AgentGrove.

#![forbid(unsafe_code)]

pub mod auth;
pub mod chats;
pub mod editor;
pub mod health;
pub mod logbus;
pub mod notes;
pub mod projects;
pub mod queue;
pub mod router;
pub mod state;
pub mod terminal;
pub mod themes;
pub mod worktrees;
pub mod ws;

pub use router::build_router;
pub use state::AppState;
