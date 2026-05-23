//! HTTP + WS API layer for AgentGrove.

#![forbid(unsafe_code)]

pub mod backups;
pub mod branches;
pub mod chats;
pub mod diag;
pub mod editor;
pub mod file_index;
pub mod files;
pub mod fs;
pub mod git;
pub mod health;
pub mod layout;
pub mod logbus;
pub mod notes;
pub mod projects;
pub mod providers;
pub mod queue;
pub mod router;
pub mod scratchpad;
pub mod settings;
pub mod state;
pub mod terminal;
pub mod themes;
pub mod uploads;
pub mod worktrees;
pub mod ws;

pub use router::build_router;
pub use state::AppState;
