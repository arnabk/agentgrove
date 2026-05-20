//! Integration-level checks for the on-the-wire shape of [`AgentEvent`].
//! These deliberately live in `tests/` (out of the crate) so they're
//! exercised against the public API the BE consumes.

use agentgrove_agents::AgentEvent;

#[test]
fn token_event_serializes_with_tag() {
    let ev = AgentEvent::Token { text: "hi".into() };
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["type"], "token");
    assert_eq!(json["text"], "hi");
}

#[test]
fn done_event_serializes_with_optional_fields() {
    let ev = AgentEvent::Done {
        result: Some("ok".into()),
        cost_usd: Some(0.01),
    };
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["type"], "done");
    assert_eq!(json["result"], "ok");
    assert!((json["cost_usd"].as_f64().unwrap() - 0.01).abs() < 1e-9);
}

#[test]
fn done_event_with_no_metadata_serializes_with_nulls() {
    let ev = AgentEvent::Done {
        result: None,
        cost_usd: None,
    };
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["type"], "done");
    assert!(json["result"].is_null());
    assert!(json["cost_usd"].is_null());
}

#[test]
fn tool_call_event_roundtrips_through_json() {
    let ev = AgentEvent::ToolCall {
        name: "read_file".into(),
        args: serde_json::json!({"path": "Cargo.toml"}),
        id: Some("toolu_42".into()),
    };
    let json = serde_json::to_string(&ev).unwrap();
    let back: AgentEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(ev, back);
}

#[test]
fn session_start_event_roundtrips_through_json() {
    let ev = AgentEvent::SessionStart {
        session_id: "abc".into(),
    };
    let json = serde_json::to_string(&ev).unwrap();
    let back: AgentEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(ev, back);
}
