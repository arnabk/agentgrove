use agentgrove_agents::AgentEvent;

#[test]
fn token_event_serializes_with_tag() {
    let ev = AgentEvent::Token { text: "hi".into() };
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["type"], "token");
    assert_eq!(json["text"], "hi");
}

#[test]
fn done_event_serializes_with_tag_only() {
    let ev = AgentEvent::Done;
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["type"], "done");
}

#[test]
fn event_roundtrips_through_json() {
    let ev = AgentEvent::ToolCall {
        name: "read_file".into(),
        args: serde_json::json!({"path": "Cargo.toml"}),
    };
    let json = serde_json::to_string(&ev).unwrap();
    let back: AgentEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(ev, back);
}
