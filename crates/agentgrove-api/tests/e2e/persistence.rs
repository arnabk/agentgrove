//! Regression suite for session persistence across server restarts.
//!
//! The point of these tests is simple: kill the BE and bring it
//! back up, and the user's chats / queue / layout must still be
//! there. The harness's `restart()` method tears down the running
//! Axum instance and spins up a fresh one against the same SQLite
//! file + state dir, mirroring what `just dev` or a real bounce
//! does.
//!
//! When you touch the persistence layer (migrations, `ChatRepo`,
//! `QueueRepo`, `LayoutRepo`, hydration) keep these green.

use crate::support::BeHarness;
use serde_json::{json, Value};

/// Helper: create a chat under a fake worktree id so we don't have
/// to also create a real project (chats' project_id has no FK on
/// purpose so legacy worktree-scoped flows keep working).
async fn make_chat(h: &BeHarness, suffix: &str) -> String {
    let res = h
        .post_auth(&format!("/api/worktrees/wt-{suffix}/chats"))
        .json(&json!({"title":suffix,"provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Chats + their prompts survive a restart. We send a couple of
/// messages so the prompt history is non-trivial and verify the
/// post-restart view matches.
#[tokio::test]
async fn chats_and_prompts_survive_restart() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "persist").await;

    // Two smart-sends. The queue is manual-only, so a message only
    // dispatches when the chat is idle; while the previous turn's
    // dispatch flag is still held a send parks in the queue instead.
    // We therefore retry each send until it reports "dispatched",
    // which also proves the dispatch flag clears after every turn.
    // Echo provider keeps each turn fast.
    for body in ["alpha", "beta"] {
        let mut dispatched = false;
        for _ in 0..100 {
            let res = h
                .post_auth(&format!("/api/chats/{chat_id}/messages"))
                .json(&json!({"content": body}))
                .send()
                .await
                .unwrap();
            let v: Value = res.json().await.unwrap();
            if v["kind"] == "dispatched" {
                dispatched = true;
                break;
            }
            // Parked (previous turn still settling) — cancel the queued
            // copy so we don't leave a duplicate, then retry.
            if let Some(item_id) = v["item_id"].as_str() {
                let _ = h
                    .delete_auth(&format!("/api/chats/{chat_id}/queue/{item_id}"))
                    .send()
                    .await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        assert!(dispatched, "'{body}' never dispatched (flag stuck?)");
        // Wait for the turn to land before sending the next.
        for _ in 0..50 {
            let view: Value = h
                .get_auth(&format!("/api/chats/{chat_id}"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let has = view["prompts"]
                .as_array()
                .map(|a| a.iter().any(|p| p["content"] == body))
                .unwrap_or(false);
            if has {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    // Restart and re-fetch.
    let h = h.restart().await;
    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 2, "prompts lost on restart: {prompts:?}");
    assert_eq!(prompts[0]["content"], "alpha");
    assert_eq!(prompts[1]["content"], "beta");
    // The echo provider emits a token + done event per turn; both
    // should be persisted via the post-dispatch flush.
    for (i, p) in prompts.iter().enumerate() {
        let evs = p["events"].as_array().unwrap();
        assert!(
            !evs.is_empty(),
            "prompt {i} lost its events on restart: {p:?}"
        );
    }
}

/// Pending queue items survive a restart. The queue is manual-only, so
/// enqueued items just sit there until the user runs them; after a
/// bounce they must still be present and in order.
#[tokio::test]
async fn queue_items_and_mode_survive_restart() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "persist-queue").await;

    // Enqueue three items directly. Nothing auto-drains (manual-only).
    for body in ["one", "two", "three"] {
        h.post_auth(&format!("/api/chats/{chat_id}/queue"))
            .json(&json!({"body": body}))
            .send()
            .await
            .unwrap();
    }

    let h = h.restart().await;
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(q["mode"], "manual", "mode lost on restart");
    let items = q["items"].as_array().unwrap();
    let bodies: Vec<&str> = items.iter().map(|i| i["body"].as_str().unwrap()).collect();
    assert_eq!(bodies, vec!["one", "two", "three"]);
    // All items must be Pending (Running rollback on startup
    // recovery is covered separately in worktrees_routes).
    for it in items {
        assert_eq!(it["status"], "pending");
    }
}

/// Layout blobs (per-scope + global) round-trip across a restart.
#[tokio::test]
async fn layout_survives_restart() {
    let h = BeHarness::start().await;

    // Write a global blob.
    let global = json!({
        "rail_width": 320,
        "show_files": false,
    });
    let res = h
        .put("/api/layout/global")
        .json(&json!({"blob": global}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    // Write a per-scope blob (project-root scope; worktree=empty).
    let scope = json!({
        "active_chat": "abc",
        "active_pane": "chat",
        "queue_open": true,
    });
    let res = h
        .put("/api/layout/scope?project=proj-1")
        .json(&json!({"blob": scope}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    let h = h.restart().await;
    let snap: Value = h
        .get_auth("/api/layout")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snap["global"], global);
    let scopes = snap["scopes"].as_array().unwrap();
    assert_eq!(scopes.len(), 1);
    assert_eq!(scopes[0]["project_id"], "proj-1");
    assert_eq!(scopes[0]["worktree_id"], "");
    assert_eq!(scopes[0]["blob"], scope);
}

/// `GET /api/layout` with no writes returns sensible defaults
/// (empty global, empty scopes list).
#[tokio::test]
async fn layout_get_returns_defaults_when_empty() {
    let h = BeHarness::start().await;
    let snap: Value = h
        .get_auth("/api/layout")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snap["global"], json!({}));
    assert!(snap["scopes"].as_array().unwrap().is_empty());
}
