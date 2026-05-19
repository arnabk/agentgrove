//! Script runner tests. Use a sleep + echo to verify streaming.

use agentgrove_scripts::{run_script, ScriptError, ScriptEvent, Shell};
use std::time::Duration;
use tempfile::tempdir;
use tokio::sync::mpsc;

#[tokio::test]
async fn runs_echo_and_streams_stdout() {
    let dir = tempdir().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let code = run_script(
        "echo hello",
        dir.path(),
        &Shell::Auto,
        Duration::from_secs(5),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(code, 0);

    let mut found = false;
    let mut got_exit = false;
    while let Some(ev) = rx.recv().await {
        match ev {
            ScriptEvent::Stdout { line } if line.trim() == "hello" => found = true,
            ScriptEvent::Exit { code } => {
                got_exit = true;
                assert_eq!(code, 0);
            }
            _ => {}
        }
    }
    assert!(found, "did not receive 'hello' on stdout");
    assert!(got_exit, "did not receive exit event");
}

#[tokio::test]
async fn non_zero_exit_is_reported() {
    let dir = tempdir().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let code = run_script(
        "exit 7",
        dir.path(),
        &Shell::Auto,
        Duration::from_secs(5),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(code, 7);
    let mut exit_seen = false;
    while let Some(ev) = rx.recv().await {
        if let ScriptEvent::Exit { code } = ev {
            assert_eq!(code, 7);
            exit_seen = true;
        }
    }
    assert!(exit_seen);
}

#[tokio::test]
async fn long_script_times_out() {
    let dir = tempdir().unwrap();
    let (tx, _rx) = mpsc::unbounded_channel();
    let err = run_script(
        "sleep 5",
        dir.path(),
        &Shell::Auto,
        Duration::from_millis(200),
        tx,
    )
    .await
    .unwrap_err();
    assert!(matches!(err, ScriptError::Timeout(_)));
}
