//! Live end-to-end check for the Kiro provider against the real
//! `kiro-cli` binary. Ignored by default (requires the CLI installed
//! and logged in); run explicitly with:
//!
//! ```sh
//! cargo test -p agentgrove-agents --test kiro_live -- --ignored --nocapture
//! ```

use agentgrove_agents::kiro::KiroProvider;
use agentgrove_agents::{AgentEvent, AgentProvider, SpawnOptions};
use tokio::sync::mpsc;

#[tokio::test]
#[ignore = "requires kiro-cli installed + logged in"]
async fn kiro_detect_reports_available_with_models() {
    let d = KiroProvider::new().detect().await;
    assert_eq!(d.label, "Kiro");
    assert!(d.available, "kiro-cli not detected on PATH");
    assert!(d.version.is_some(), "no version string");
    assert!(!d.models.is_empty(), "no models from --list-models");
    assert!(d.supports_resume);
    eprintln!(
        "detect: version={:?} models={} first={:?}",
        d.version,
        d.models.len(),
        d.models.first()
    );
}

#[tokio::test]
#[ignore = "requires kiro-cli installed + logged in"]
async fn kiro_spawn_streams_session_token_and_done() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let opts = SpawnOptions {
        cwd: std::env::temp_dir(),
        auto_approve_tools: false,
        ..Default::default()
    };
    KiroProvider::new()
        .spawn(
            "Reply with exactly the word: pong. Do not use any tools.",
            opts,
            tx,
        )
        .await
        .expect("spawn failed");

    let mut events = Vec::new();
    while let Some(ev) = rx.recv().await {
        events.push(ev);
    }

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::SessionStart { .. })),
        "no SessionStart; got {events:?}"
    );
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Token { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert!(
        text.to_lowercase().contains("pong"),
        "assistant text missing 'pong': {text:?}"
    );
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::Done { .. })),
        "no Done; got {events:?}"
    );
    assert!(
        !events.iter().any(|e| matches!(e, AgentEvent::Error { .. })),
        "unexpected Error event: {events:?}"
    );
    eprintln!("spawn produced {} events", events.len());
}
