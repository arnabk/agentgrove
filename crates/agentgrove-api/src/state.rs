//! Shared application state.

use crate::logbus::LogBus;
use agentgrove_store::{DbPool, ProjectRepo, WorktreeRepo};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// Application state injected into Axum handlers.
#[derive(Clone)]
pub struct AppState {
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
    /// Registry of agent providers (Claude, future Codex/OpenCode/…).
    pub providers: crate::providers::ProviderRegistry,
    /// Chats currently being dispatched (an agent turn is in flight,
    /// possibly draining the queue afterward). The smart-send handler
    /// checks this to decide whether to dispatch or enqueue — making
    /// the decision authoritative on the server, never racing with
    /// FE state.
    ///
    /// Uses a `tokio::sync::Mutex` so handlers can hold it across
    /// `.await` points without poisoning the executor's Send bounds.
    /// The `DispatchGuard` panic-safety cleanup can't `.await`
    /// inside `Drop`; it gets the lock by spawning a fresh task —
    /// happy-path callers clear the flag synchronously themselves
    /// (the guard is just an insurance policy for panics).
    pub dispatching: Arc<Mutex<HashSet<String>>>,
}

impl AppState {
    /// Construct fresh state. Auth is not part of the model — the server
    /// binds to loopback by default and trusts the host.
    #[must_use]
    pub fn new(state_dir: PathBuf, db: DbPool) -> Self {
        let projects = ProjectRepo::new(db.clone());
        let worktrees = WorktreeRepo::new(db.clone());
        Self {
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
            providers: crate::providers::ProviderRegistry::default(),
            dispatching: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}
