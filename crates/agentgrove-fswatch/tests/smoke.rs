#[test]
fn host_supports_a_recommended_watcher() {
    agentgrove_fswatch::smoke_recommended_watcher().expect("watcher backend available");
}
