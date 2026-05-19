//! Shared application state.

use crate::logbus::LogBus;
use agentgrove_store::{DbPool, ProjectRepo, WorktreeRepo};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Application state injected into Axum handlers.
#[derive(Clone)]
pub struct AppState {
    /// Bearer token required by protected routes.
    pub token: Arc<String>,
    /// Filesystem state directory (default: `<repo>/.data`).
    pub state_dir: Arc<PathBuf>,
    /// SQLite pool.
    pub db: DbPool,
    /// Project repository.
    pub projects: ProjectRepo,
    /// Worktree repository.
    pub worktrees: WorktreeRepo,
    /// Log broadcast bus for streaming script / terminal / chat output.
    pub logbus: Arc<LogBus>,
    /// In-memory chat aggregate registry.
    pub chats: Arc<RwLock<crate::chats::ChatRegistry>>,
    /// In-memory notes (per chat).
    pub notes: Arc<RwLock<crate::notes::NoteRegistry>>,
    /// In-memory prompt queues (per chat).
    pub queues: Arc<RwLock<crate::queue::QueueRegistry>>,
    /// In-memory open-file cache for editor (path -> bytes).
    pub editor: Arc<RwLock<crate::editor::EditorState>>,
    /// PTY session manager.
    pub terminals: Arc<crate::terminal::TerminalManager>,
}

impl AppState {
    /// Construct fresh state for the given token, state dir, and pool.
    #[must_use]
    pub fn new(token: impl Into<String>, state_dir: PathBuf, db: DbPool) -> Self {
        let projects = ProjectRepo::new(db.clone());
        let worktrees = WorktreeRepo::new(db.clone());
        Self {
            token: Arc::new(token.into()),
            state_dir: Arc::new(state_dir),
            db,
            projects,
            worktrees,
            logbus: Arc::new(LogBus::default()),
            chats: Arc::new(RwLock::new(crate::chats::ChatRegistry::default())),
            notes: Arc::new(RwLock::new(crate::notes::NoteRegistry::default())),
            queues: Arc::new(RwLock::new(crate::queue::QueueRegistry::default())),
            editor: Arc::new(RwLock::new(crate::editor::EditorState::default())),
            terminals: Arc::new(crate::terminal::TerminalManager::default()),
        }
    }
}
