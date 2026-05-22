//! AgentGrove server binary.

use agentgrove_api::{build_router, AppState};
use agentgrove_store::{open_pool, run_migrations};
use anyhow::{Context, Result};
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use tokio::fs;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let bind_addr: IpAddr = env::var("AGENTGROVE_BIND")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let port: u16 = env::var("AGENTGROVE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let state_dir = match env::var("AGENTGROVE_STATE_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => env::current_dir().context("cwd")?.join(".data"),
    };
    fs::create_dir_all(&state_dir)
        .await
        .with_context(|| format!("create state dir {}", state_dir.display()))?;

    let pool = open_pool(&state_dir).await.context("open db")?;
    run_migrations(&pool).await.context("run migrations")?;

    if !bind_addr.is_loopback() {
        tracing::warn!(%bind_addr, "binding to non-loopback");
    }

    let state = AppState::new(state_dir.clone(), pool);

    // Best-effort recovery: rewrite worktree rows that were left in
    // a transient lifecycle state (`creating`, `pre_script`,
    // `removing`) by a previous run of the server that didn't shut
    // down cleanly. Without this the FE would keep showing stale
    // "removing" pills forever. Errors are logged but non-fatal —
    // the server still starts so the user can investigate.
    match state.worktrees.recover_stale_lifecycle().await {
        Ok(0) => {}
        Ok(n) => tracing::info!(rows = n, "recovered stale worktree lifecycle rows"),
        Err(e) => tracing::warn!(error = %e, "worktree lifecycle recovery failed"),
    }

    // Roll any queue items left mid-dispatch back to Pending. A
    // crashed dispatch task could otherwise leave items as Running
    // with no task tracking them — `run_next` (which only pops
    // Pending) would then ignore them forever.
    match state.queue_store.recover_stale_running().await {
        Ok(0) => {}
        Ok(n) => tracing::info!(rows = n, "rolled stale Running queue items back to Pending"),
        Err(e) => tracing::warn!(error = %e, "queue recovery failed"),
    }

    // Hydrate the in-memory chat registry from the persistent store
    // so chats + their prompt history survive a server restart.
    // Done before serving so the first request sees the cache
    // already populated.
    agentgrove_api::chats::hydrate_from_store(&state).await;

    let app = build_router(state);

    let addr = SocketAddr::new(bind_addr, port);
    let listener = TcpListener::bind(addr).await.context("bind tcp listener")?;
    let local = listener.local_addr().context("local_addr")?;
    tracing::info!(%local, state_dir = %state_dir.display(), "agentgrove server listening");
    println!("agentgrove listening on http://{local}");
    println!("state dir: {}", state_dir.display());
    axum::serve(listener, app).await.context("axum serve")?;
    Ok(())
}
