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
    // Auth is disabled by default. Set AGENTGROVE_TOKEN to enable.
    let token = env::var("AGENTGROVE_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

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

    let state = AppState::new(token.clone(), state_dir.clone(), pool);
    let app = build_router(state);

    let addr = SocketAddr::new(bind_addr, port);
    let listener = TcpListener::bind(addr).await.context("bind tcp listener")?;
    let local = listener.local_addr().context("local_addr")?;
    tracing::info!(%local, state_dir = %state_dir.display(), auth = token.is_some(), "agentgrove server listening");
    println!("agentgrove listening on http://{local}");
    println!("state dir: {}", state_dir.display());
    match &token {
        Some(t) => println!("token: {t}"),
        None => println!("auth: disabled (set AGENTGROVE_TOKEN to enable)"),
    }
    axum::serve(listener, app).await.context("axum serve")?;
    Ok(())
}
