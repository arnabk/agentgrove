//! Cross-platform PTY smoke test.

#[test]
fn can_open_a_pty_on_this_host() {
    agentgrove_pty::smoke_open().expect("host must support PTY allocation");
}
