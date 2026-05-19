//! AgentGrove server binary.

use agentgrove_api::{build_router, AppState};
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

    // Configuration: env-only for M0. Real `clap` CLI lands in M1.
    let bind_addr: IpAddr = env::var("AGENTGROVE_BIND")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let port: u16 = env::var("AGENTGROVE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let token = env::var("AGENTGROVE_TOKEN").unwrap_or_else(|_| {
        // Generate a one-shot token for local dev when none is provided.
        uuid::Uuid::new_v4().to_string()
    });

    // State directory. Default: `<cwd>/.data`. Override via env.
    let state_dir = match env::var("AGENTGROVE_STATE_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => env::current_dir()
            .context("read current dir")?
            .join(".data"),
    };
    fs::create_dir_all(&state_dir)
        .await
        .with_context(|| format!("create state dir {}", state_dir.display()))?;

    if !bind_addr.is_loopback() {
        tracing::warn!(
            %bind_addr,
            "binding to a non-loopback address; ensure your network is trusted"
        );
    }

    let state = AppState::new(token.clone());
    let app = build_router(state);

    let addr = SocketAddr::new(bind_addr, port);
    let listener = TcpListener::bind(addr).await.context("bind tcp listener")?;
    let local = listener.local_addr().context("read local addr")?;
    tracing::info!(%local, state_dir = %state_dir.display(), "agentgrove server listening");
    println!("agentgrove listening on http://{local}");
    println!("state dir: {}", state_dir.display());
    println!("token: {token}");

    axum::serve(listener, app).await.context("axum serve")?;
    Ok(())
}
