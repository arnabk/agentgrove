//! Shared application state.

use crate::logbus::LogBus;
use agentgrove_store::{
    ChatRepo, DbPool, LayoutRepo, ProjectRepo, ProviderSecretRepo, QueueRepo, SecretKeyring,
    WorktreeRepo,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
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
    /// Persistent chat + prompt store. The in-memory `chats`
    /// registry below is a write-through cache over this; the
    /// store is the source of truth for what survives a restart.
    pub chat_store: ChatRepo,
    /// Persistent per-chat queue + mode toggle.
    pub queue_store: QueueRepo,
    /// Per-(project, worktree?) UI layout blobs + a singleton
    /// global blob. The FE writes through to this on every
    /// scope mutation so the layout follows the user across
    /// machines.
    pub layouts: LayoutRepo,
    /// Encrypted per-provider API key + base URL. Used by
    /// HTTP-API providers (9router and future OpenAI-compatible
    /// aggregators). The store decrypts via a machine-bound key at
    /// `<state_dir>/secrets.key`.
    pub provider_secrets: ProviderSecretRepo,
    /// Log broadcast bus for streaming script / terminal / chat output.
    pub logbus: Arc<LogBus>,
    /// In-memory chat aggregate registry.
    pub chats: Arc<RwLock<crate::chats::ChatRegistry>>,
    /// In-memory notes (per chat).
    pub notes: Arc<RwLock<crate::notes::NoteRegistry>>,

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
    /// Per-chat cancellation tokens. The dispatch task installs
    /// one before spawning the provider; `POST /api/chats/:id/cancel`
    /// flips it, which causes the `tokio::select!` wrapping the
    /// provider call to bail out — dropping the child `Command`
    /// (spawned with `kill_on_drop`) and ending the turn.
    pub cancel_tokens: Arc<Mutex<HashMap<String, tokio_util::sync::CancellationToken>>>,
    /// Per-project in-memory file index (Cmd+P fuzzy finder).
    /// Lazily populated on first search; the FE can also call
    /// `POST /api/projects/:id/files/reindex` to force a re-scan.
    pub file_index: crate::file_index::FileIndex,
    /// Cached latest-version check from GitHub, refreshed on a TTL.
    pub version_cache: Arc<Mutex<Option<(crate::health::VersionInfo, Instant)>>>,
}

impl AppState {
    /// Construct fresh state. Auth is not part of the model — the server
    /// binds to loopback by default and trusts the host.
    #[must_use]
    pub fn new(state_dir: PathBuf, db: DbPool) -> Self {
        let projects = ProjectRepo::new(db.clone());
        let worktrees = WorktreeRepo::new(db.clone());
        let chat_store = ChatRepo::new(db.clone());
        let queue_store = QueueRepo::new(db.clone());
        let layouts = LayoutRepo::new(db.clone());
        // Open (or create on first run) the at-rest encryption key.
        // We deliberately panic on failure here — a server that
        // can't manage its own secrets keyring shouldn't pretend to
        // be usable. The error message points the operator at the
        // file so they can fix it (e.g. delete a corrupt key file
        // and let us regenerate).
        let keyring = SecretKeyring::open(&state_dir).expect("open secrets keyring");
        let provider_secrets = ProviderSecretRepo::new(db.clone(), keyring);
        Self {
            state_dir: Arc::new(state_dir),
            db,
            projects,
            worktrees,
            chat_store,
            queue_store,
            layouts,
            provider_secrets,
            logbus: Arc::new(LogBus::default()),
            chats: Arc::new(RwLock::new(crate::chats::ChatRegistry::default())),
            notes: Arc::new(RwLock::new(crate::notes::NoteRegistry::default())),

            editor: Arc::new(RwLock::new(crate::editor::EditorState::default())),
            terminals: Arc::new(crate::terminal::TerminalManager::default()),
            providers: crate::providers::ProviderRegistry::default(),
            dispatching: Arc::new(Mutex::new(HashSet::new())),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
            file_index: crate::file_index::FileIndex::new(),
            version_cache: Arc::new(Mutex::new(None)),
        }
    }
}
