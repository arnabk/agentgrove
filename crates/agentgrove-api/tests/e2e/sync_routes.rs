//! E2E for the cross-instance `sync` WebSocket topic.
//!
//! Every mutation against projects / worktrees / chats /
//! scratchpad publishes a small JSON frame on the `sync` topic so
//! any number of connected clients (different browsers, different
//! machines) stay in step. These tests subscribe to `/ws?topic=sync`
//! and assert each kind of frame lands in the right shape after
//! the matching HTTP mutation fires.
//!
//! Pattern follows
//! `chat_queue_notes_routes::smart_send_publishes_chat_idle_after_dispatch_completes`
//! — connect, drain the `{"subscribed":"sync"}` hello, fire the
//! mutation, collect frames for up to a few seconds.

use crate::support::BeHarness;
use futures::{SinkExt as _, StreamExt as _};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// Open a WS subscription to the global `sync` topic and drain the
/// hello frame. Returns the live stream + sink so the caller can
/// keep reading.
async fn open_sync_ws(
    h: &BeHarness,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let ws_url = h.base_url.replace("http://", "ws://") + "/ws?topic=sync";
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("connect sync ws");
    let _ = ws.next().await; // {"subscribed":"sync"}
    ws
}

/// Read frames until one whose `kind` matches `want` lands, or the
/// timeout expires. Returns the matched frame so the caller can
/// assert on its payload fields.
async fn read_until(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    want: &str,
) -> Option<Value> {
    for _ in 0..40 {
        let frame = tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = frame else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if parsed["kind"] == want {
            return Some(parsed);
        }
    }
    None
}

#[tokio::test]
async fn project_create_publishes_project_created_frame() {
    let h = BeHarness::start().await;
    let mut ws = open_sync_ws(&h).await;

    let dir = tempfile::tempdir().unwrap();
    let res = h
        .post_auth("/api/projects")
        .json(&json!({"name":"sync","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let project_id = body["id"].as_str().unwrap().to_string();

    let frame = read_until(&mut ws, "project_created")
        .await
        .expect("expected project_created frame on sync topic");
    assert_eq!(frame["project_id"], project_id);

    let _ = ws.close(None).await;
}

#[tokio::test]
async fn project_delete_publishes_project_deleted_frame() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let created: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"d","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pid = created["id"].as_str().unwrap().to_string();

    // Subscribe AFTER the create + before the delete so the
    // create event isn't sitting in our recv queue.
    let mut ws = open_sync_ws(&h).await;

    h.delete_auth(&format!("/api/projects/{pid}"))
        .send()
        .await
        .unwrap();
    let frame = read_until(&mut ws, "project_deleted")
        .await
        .expect("project_deleted frame missing");
    assert_eq!(frame["project_id"], pid);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn project_patch_publishes_project_updated_frame() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let created: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"u","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pid = created["id"].as_str().unwrap().to_string();
    let mut ws = open_sync_ws(&h).await;

    h.patch(&format!("/api/projects/{pid}"))
        .json(&json!({"pre_worktree_script":"echo hi"}))
        .send()
        .await
        .unwrap();
    let frame = read_until(&mut ws, "project_updated")
        .await
        .expect("project_updated frame missing");
    assert_eq!(frame["project_id"], pid);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn chat_create_publishes_chat_created_frame() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let project: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"c","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pid = project["id"].as_str().unwrap().to_string();
    let mut ws = open_sync_ws(&h).await;

    let chat: Value = h
        .post_auth(&format!("/api/projects/{pid}/chats"))
        .json(&json!({"title":"hello","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let frame = read_until(&mut ws, "chat_created")
        .await
        .expect("chat_created missing");
    assert_eq!(frame["chat_id"], chat_id);
    assert_eq!(frame["project_id"], pid);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn chat_patch_publishes_chat_updated_frame() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let project: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"cu","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pid = project["id"].as_str().unwrap().to_string();
    let chat: Value = h
        .post_auth(&format!("/api/projects/{pid}/chats"))
        .json(&json!({"title":"orig","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_string();
    let mut ws = open_sync_ws(&h).await;

    h.patch(&format!("/api/chats/{chat_id}"))
        .json(&json!({"title":"renamed"}))
        .send()
        .await
        .unwrap();

    let frame = read_until(&mut ws, "chat_updated")
        .await
        .expect("chat_updated missing");
    assert_eq!(frame["chat_id"], chat_id);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn scratchpad_put_publishes_scratchpad_updated_frame() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let project: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"s","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pid = project["id"].as_str().unwrap().to_string();
    let mut ws = open_sync_ws(&h).await;

    h.put(&format!("/api/projects/{pid}/scratchpad"))
        .json(&json!({"body":"<p>hello</p>"}))
        .send()
        .await
        .unwrap();

    let frame = read_until(&mut ws, "scratchpad_updated")
        .await
        .expect("scratchpad_updated missing");
    assert_eq!(frame["project_id"], pid);
    assert!(frame["updated_at"].is_string());
    let _ = ws.close(None).await;
}
