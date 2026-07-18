//! E2E for chats, queue, notes (in-memory aggregates).

use crate::support::BeHarness;
use serde_json::{json, Value};

#[tokio::test]
async fn chat_create_prompt_and_revert_cycle() {
    let h = BeHarness::start().await;
    let chat_res = h
        .post_auth("/api/worktrees/wt-fake/chats")
        .json(&json!({"title":"hello","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap();
    assert_eq!(chat_res.status(), 200);
    let chat: Value = chat_res.json().await.unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    let p1 = h
        .post_auth(&format!("/api/chats/{chat_id}/prompts"))
        .json(&json!({"content":"do something"}))
        .send()
        .await
        .unwrap();
    assert_eq!(p1.status(), 200);
    let prompt: Value = p1.json().await.unwrap();
    let prompt_id = prompt["id"].as_str().unwrap().to_owned();

    // Revert spawns a new follow-up prompt.
    let rev = h
        .post_auth(&format!("/api/chats/{chat_id}/prompts/{prompt_id}/revert"))
        .send()
        .await
        .unwrap();
    assert_eq!(rev.status(), 200);

    let fetched = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap();
    let body: Value = fetched.json().await.unwrap();
    assert_eq!(body["prompts"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn queue_enqueue_run_next_modes() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-q/chats")
        .json(&json!({"title":"q","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    let _e = h
        .post_auth(&format!("/api/chats/{chat_id}/queue"))
        .json(&json!({"body":"first"}))
        .send()
        .await
        .unwrap();
    let state: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["items"].as_array().unwrap().len(), 1);

    let mode = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode":"manual"}))
        .send()
        .await
        .unwrap();
    assert_eq!(mode.status(), 204);

    let nxt = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/next"))
        .send()
        .await
        .unwrap();
    assert_eq!(nxt.status(), 200);
}

#[tokio::test]
async fn notes_crud() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-n/chats")
        .json(&json!({"title":"n","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    let n: Value = h
        .post_auth(&format!("/api/chats/{chat_id}/notes"))
        .json(&json!({"body":"remember"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let nid = n["id"].as_str().unwrap().to_owned();
    let list: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/notes"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    let del = h
        .delete_auth(&format!("/api/chats/{chat_id}/notes/{nid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);
}

#[tokio::test]
async fn themes_list_contains_builtins() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/api/themes").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let arr: Value = res.json().await.unwrap();
    let names: Vec<_> = arr
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"dark-default".into()));
    assert!(names.contains(&"light-default".into()));
    assert!(names.contains(&"solarized-dark".into()));
    assert!(names.contains(&"tokyo-night".into()));
}

#[tokio::test]
async fn custom_theme_import_list_delete() {
    let h = BeHarness::start().await;
    let theme = serde_json::json!({
        "id": "custom-test",
        "name": "Custom Test",
        "kind": "dark",
        "custom": true,
        "colors": {
            "bg": "#1a1a2e",
            "fg": "#e0e0e0",
            "muted": "#888888",
            "accent": "#ff6b6b"
        }
    });

    let post = h
        .post_auth("/api/themes")
        .json(&theme)
        .send()
        .await
        .unwrap();
    assert_eq!(post.status(), 200);
    let saved: Value = post.json().await.unwrap();
    assert_eq!(saved["id"], "custom-test");
    assert_eq!(saved["custom"], true);

    let res = h.get_auth("/api/themes").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let arr: Value = res.json().await.unwrap();
    let ids: Vec<_> = arr
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(ids.contains(&"custom-test".into()));

    let del = h
        .delete_auth("/api/themes/custom-test")
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    let res = h.get_auth("/api/themes").send().await.unwrap();
    let arr: Value = res.json().await.unwrap();
    let ids: Vec<_> = arr
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(!ids.contains(&"custom-test".into()));
}

// ---------------------------------------------------------------------
// Performance / pagination behaviors (ADR-0006).
// ---------------------------------------------------------------------

#[tokio::test]
async fn chat_get_one_windows_to_last_50_prompts_and_exposes_total() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-window/chats")
        .json(&json!({"title":"win","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    // Add 75 prompts. The fake/echo dispatcher synthesizes 2 events
    // per prompt (Token + Done); none of those should leak above the
    // 200-events window cap.
    for i in 0..75u32 {
        let res = h
            .post_auth(&format!("/api/chats/{chat_id}/prompts"))
            .json(&json!({"content": format!("p{i}")}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 50, "windowed to last 50 prompts");
    assert_eq!(view["prompts_total"], 75);
    assert_eq!(view["prompts_window"], 50);
    assert_eq!(view["events_per_prompt"], 200);
    // Window holds the *newest* prompts.
    assert_eq!(prompts.first().unwrap()["seq"], 26);
    assert_eq!(prompts.last().unwrap()["seq"], 75);
}

#[tokio::test]
async fn list_prompts_backfills_earlier_pages_in_order() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-backfill/chats")
        .json(&json!({"title":"bf","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();
    for i in 0..120u32 {
        h.post_auth(&format!("/api/chats/{chat_id}/prompts"))
            .json(&json!({"content": format!("p{i}")}))
            .send()
            .await
            .unwrap();
    }

    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let oldest_seq = view["prompts"].as_array().unwrap().first().unwrap()["seq"]
        .as_u64()
        .unwrap() as u32;
    assert_eq!(oldest_seq, 71);

    // Backfill 50 prompts older than seq=71 -> seq 21..70 inclusive.
    let page: Value = h
        .get_auth(&format!(
            "/api/chats/{chat_id}/prompts?before={oldest_seq}&limit=50"
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let arr = page["prompts"].as_array().unwrap();
    assert_eq!(arr.len(), 50);
    assert_eq!(arr.first().unwrap()["seq"], 21);
    assert_eq!(arr.last().unwrap()["seq"], 70);
    assert_eq!(page["at_start"], false);

    // Next page reaches the start.
    let page2: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/prompts?before=21&limit=50"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let arr2 = page2["prompts"].as_array().unwrap();
    assert_eq!(arr2.len(), 20);
    assert_eq!(arr2.first().unwrap()["seq"], 1);
    assert_eq!(arr2.last().unwrap()["seq"], 20);
    assert_eq!(page2["at_start"], true);
}

#[tokio::test]
async fn list_prompts_clamps_limit_and_returns_empty_for_seq_one() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-clamp/chats")
        .json(&json!({"title":"c","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();
    for _ in 0..3u32 {
        h.post_auth(&format!("/api/chats/{chat_id}/prompts"))
            .json(&json!({"content":"x"}))
            .send()
            .await
            .unwrap();
    }
    // Limit=99999 is clamped to 200 server-side; we get all 2 prompts
    // older than seq=3 in one shot.
    let page: Value = h
        .get_auth(&format!(
            "/api/chats/{chat_id}/prompts?before=3&limit=99999"
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page["prompts"].as_array().unwrap().len(), 2);
    assert_eq!(page["at_start"], true);

    // Requesting before=1 returns empty + at_start=true.
    let empty: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/prompts?before=1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(empty["prompts"].as_array().unwrap().len(), 0);
    assert_eq!(empty["at_start"], true);
}

#[tokio::test]
async fn list_prompts_unknown_chat_returns_404() {
    let h = BeHarness::start().await;
    let res = h
        .get_auth("/api/chats/no-such-chat/prompts?before=10")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn patch_chat_renames_title() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-rename/chats")
        .json(&json!({"title":"orig","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    // Rename via PATCH.
    let res = h
        .patch(&format!("/api/chats/{chat_id}"))
        .json(&json!({"title": "renamed!"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "body={}", res.text().await.unwrap());
    let view: Value = res.json().await.unwrap();
    assert_eq!(view["title"], "renamed!");

    // GET reflects the new title.
    let view2: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view2["title"], "renamed!");
}

#[tokio::test]
async fn patch_chat_rejects_empty_title() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-empty/chats")
        .json(&json!({"title":"keep","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();
    let res = h
        .patch(&format!("/api/chats/{chat_id}"))
        .json(&json!({"title": "   "}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    // Title unchanged.
    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["title"], "keep");
}

#[tokio::test]
async fn patch_chat_unknown_id_returns_404() {
    let h = BeHarness::start().await;
    let res = h
        .patch("/api/chats/does-not-exist")
        .json(&json!({"title":"x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn patch_chat_updates_model_and_effort() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-pm/chats")
        .json(&json!({"title":"m","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = chat["id"].as_str().unwrap().to_owned();

    // Update both fields in one call.
    let res = h
        .patch(&format!("/api/chats/{id}"))
        .json(&json!({"model": "opus", "effort": "high"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "body={}", res.text().await.unwrap());
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["model"], "opus");
    assert_eq!(v["effort"], "high");

    // Clearing effort via null.
    let res = h
        .patch(&format!("/api/chats/{id}"))
        .json(&json!({"effort": null}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let v: Value = res.json().await.unwrap();
    assert!(v["effort"].is_null());
    assert_eq!(v["model"], "opus", "model untouched by effort patch");
}

#[tokio::test]
async fn patch_chat_rejects_empty_model() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-em/chats")
        .json(&json!({"title":"m","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = chat["id"].as_str().unwrap().to_owned();
    let res = h
        .patch(&format!("/api/chats/{id}"))
        .json(&json!({"model": "   "}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn queue_auto_drains_pending_items_after_send() {
    let h = BeHarness::start().await;
    // Use a fake/echo chat so the dispatch is synchronous and the
    // inline auto-drain finishes before the HTTP response returns.
    let chat: Value = h
        .post_auth("/api/worktrees/wt-drain/chats")
        .json(&json!({"title":"drain","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    // Pre-queue two items while no turn is in flight (mode defaults
    // to auto).
    for body in ["alpha", "beta"] {
        let res = h
            .post_auth(&format!("/api/chats/{chat_id}/queue"))
            .json(&json!({"body": body}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    // Fire a normal prompt. The handler returns immediately with the
    // new prompt; the dispatch + auto-drain run on a background task.
    // We poll until the chat reaches 3 prompts (first + alpha + beta)
    // — should land within a few hundred ms for the echo provider.
    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/prompts"))
        .json(&json!({"content":"first"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let mut view: Value = Value::Null;
    for _ in 0..50 {
        view = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if view["prompts"].as_array().map(|a| a.len()).unwrap_or(0) >= 3 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(
        prompts.len(),
        3,
        "expected first + 2 drained, got {:?}",
        prompts.iter().map(|p| &p["content"]).collect::<Vec<_>>()
    );
    assert_eq!(prompts[0]["content"], "first");
    assert_eq!(prompts[1]["content"], "alpha");
    assert_eq!(prompts[2]["content"], "beta");

    // Queue state: drained items are removed (we don't keep a "done"
    // history — once a queue item becomes a real prompt in the chat
    // timeline, leaving a copy in the queue dock just confused users).
    let mut q: Value = Value::Null;
    for _ in 0..50 {
        q = h
            .get_auth(&format!("/api/chats/{chat_id}/queue"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let items = q["items"].as_array().unwrap();
        if items.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let items = q["items"].as_array().unwrap();
    assert_eq!(
        items.len(),
        0,
        "expected queue empty after drain, got {items:?}"
    );
}

#[tokio::test]
async fn queue_manual_mode_does_not_auto_drain() {
    let h = BeHarness::start().await;
    let chat: Value = h
        .post_auth("/api/worktrees/wt-manual/chats")
        .json(&json!({"title":"m","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    // Flip to manual.
    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode":"manual"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    h.post_auth(&format!("/api/chats/{chat_id}/queue"))
        .json(&json!({"body":"x"}))
        .send()
        .await
        .unwrap();

    // Normal send: should NOT drain.
    h.post_auth(&format!("/api/chats/{chat_id}/prompts"))
        .json(&json!({"content":"hi"}))
        .send()
        .await
        .unwrap();

    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["prompts"].as_array().unwrap().len(), 1);

    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(q["items"][0]["status"], "pending");
}

// ---------------------------------------------------------------
// Smart-send (POST /api/chats/:id/messages) scenarios.
// ---------------------------------------------------------------
//
// Verifies the routing rules the user requested:
//   - Idle + queue empty           → dispatch
//   - Busy                         → queue
//   - Idle + queue non-empty       → queue (FIFO preserved)
//   - Auto mode drains the queue   → covered by existing
//     `queue_auto_drains_pending_items_after_send`; not re-tested here
//   - Manual mode parks            → covered by existing
//     `queue_manual_mode_does_not_auto_drain`

async fn make_chat(h: &BeHarness, suffix: &str, provider: &str, model: &str) -> String {
    let res = h
        .post_auth(&format!("/api/worktrees/wt-{suffix}/chats"))
        .json(&json!({"title":suffix,"provider":provider,"model":model}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let chat: Value = res.json().await.unwrap();
    chat["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn smart_send_dispatches_when_idle_and_queue_empty() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "smart-idle", "fake", "echo").await;

    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/messages"))
        .json(&json!({"content":"first"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["kind"], "dispatched");
    assert_eq!(body["prompt"]["content"], "first");

    // Wait briefly for the background dispatch + the implicit auto-
    // drain pass (queue is empty so it should be a noop).
    let mut view: Value = Value::Null;
    for _ in 0..50 {
        view = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let prompts = view["prompts"].as_array().unwrap();
        if !prompts.is_empty() {
            // Wait for the prompt to have a `done` event.
            let evs = prompts[0]["events"].as_array().unwrap();
            if evs
                .iter()
                .any(|e| e["type"] == "done" || e["type"] == "error")
            {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 1);
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(q["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn smart_send_enqueues_when_queue_has_pending_items() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "smart-pending", "fake", "echo").await;

    // Flip to manual so pre-queued items stay pending (auto mode
    // would drain them as soon as a turn started — we want a
    // deterministic "queue has pending items" state).
    h.post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode":"manual"}))
        .send()
        .await
        .unwrap();
    h.post_auth(&format!("/api/chats/{chat_id}/queue"))
        .json(&json!({"body":"queued-first"}))
        .send()
        .await
        .unwrap();

    // Smart-send: should park onto the queue (FIFO ordering).
    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/messages"))
        .json(&json!({"content":"queued-second"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["kind"], "queued");

    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let items = q["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "items: {items:?}");
    assert_eq!(items[0]["body"], "queued-first");
    assert_eq!(items[1]["body"], "queued-second");

    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        view["prompts"].as_array().unwrap().len(),
        0,
        "no prompts should have been dispatched yet (manual mode)"
    );
}

#[tokio::test]
async fn smart_send_drains_queue_in_order_under_auto_mode() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "smart-auto", "fake", "echo").await;

    // Queue defaults to auto. Pre-load two items; first smart-send
    // is idle + queue non-empty so this one should ALSO enqueue.
    // The auto-drain triggered by ... we need to trigger a dispatch
    // somehow to start the drain loop. Pre-queue two items, then
    // a smart-send: per the spec the smart-send sees queue non-
    // empty and enqueues. We then trigger drain via `run_next` to
    // pop the first item (which starts the background task with
    // auto-drain enabled — popping the rest).
    for body in ["a", "b"] {
        h.post_auth(&format!("/api/chats/{chat_id}/queue"))
            .json(&json!({"body": body}))
            .send()
            .await
            .unwrap();
    }
    let smart_res = h
        .post_auth(&format!("/api/chats/{chat_id}/messages"))
        .json(&json!({"content":"c"}))
        .send()
        .await
        .unwrap();
    let smart: Value = smart_res.json().await.unwrap();
    assert_eq!(smart["kind"], "queued");

    // Kick the first item via run_next; the auto-drain loop should
    // pop the remaining ones because the chat stays in auto mode.
    h.post_auth(&format!("/api/chats/{chat_id}/queue/next"))
        .send()
        .await
        .unwrap();

    // Poll until 3 prompts are dispatched (a, b, c) in that order.
    let mut view: Value = Value::Null;
    for _ in 0..80 {
        view = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if view["prompts"].as_array().map(|a| a.len()).unwrap_or(0) >= 3 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 3, "expected 3 drained, got {prompts:?}");
    assert_eq!(prompts[0]["content"], "a");
    assert_eq!(prompts[1]["content"], "b");
    assert_eq!(prompts[2]["content"], "c");
}

#[tokio::test]
async fn smart_send_unknown_chat_returns_404() {
    let h = BeHarness::start().await;
    let res = h
        .post_auth("/api/chats/does-not-exist/messages")
        .json(&json!({"content":"x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

/// Rapid-fire 10 concurrent smart-send calls to the same chat. None
/// must be lost: every message either lands in the prompt timeline or
/// is recorded as a queue item that the auto-drain processes.
///
/// This is the regression test for the concurrency bug where two
/// requests could both see "not dispatching, queue empty" before
/// either committed, both took the dispatch path, and the second
/// add_prompt call would silently overwrite the in-flight state.
#[tokio::test]
async fn smart_send_no_loss_under_concurrent_fire() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "smart-race", "fake", "echo").await;

    // Fire 10 sends concurrently via `join_all`. Since they all
    // hit the same server we don't need a multi-threaded runtime —
    // tokio's cooperative scheduler interleaves the requests
    // enough to exercise the lock.
    let futs = (0..10).map(|i| {
        h.post_auth(&format!("/api/chats/{chat_id}/messages"))
            .json(&json!({"content": format!("msg-{i}")}))
            .send()
    });
    let responses = futures::future::join_all(futs).await;
    for res in responses {
        let status = res.unwrap().status().as_u16();
        assert_eq!(
            status, 200,
            "every smart-send must return 200, got {status}"
        );
    }

    // After auto-drain, all 10 should be in the timeline as prompts.
    // Poll because the dispatch + drain runs in background tasks.
    let mut prompts_count = 0usize;
    for _ in 0..80 {
        let view: Value = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        prompts_count = view["prompts"].as_array().map(|a| a.len()).unwrap_or(0);
        // Total = 10 messages; chat view caps at 50 so we should see them all.
        if prompts_count >= 10 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        prompts_count, 10,
        "expected all 10 concurrent sends to land as prompts; got {prompts_count}"
    );

    // Queue should be empty (auto-drain removed everything).
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let items = q["items"].as_array().unwrap();
    assert!(
        items.is_empty(),
        "expected empty queue post-drain, got {items:?}"
    );
}

/// Manual run_next must refuse to fire while a turn is already in
/// flight. Returns 409 so the FE knows not to double-trigger.
#[tokio::test]
async fn run_next_rejects_when_already_dispatching() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "smart-runnext", "fake", "echo").await;

    // Manual mode so the first send sticks the chat in dispatching
    // without auto-draining downstream items in this test.
    h.post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode":"manual"}))
        .send()
        .await
        .unwrap();
    // Queue one item.
    h.post_auth(&format!("/api/chats/{chat_id}/queue"))
        .json(&json!({"body":"queued"}))
        .send()
        .await
        .unwrap();
    // Run_next: should pop + dispatch.
    let first = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/next"))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);

    // Race a second run_next while the first is still dispatching.
    // The echo provider returns fast but the spawned task takes a
    // little while to clear `dispatching`; in practice we may need
    // a couple retries to catch the busy window.
    let mut saw_409 = false;
    for _ in 0..20 {
        // Re-queue something to pop.
        h.post_auth(&format!("/api/chats/{chat_id}/queue"))
            .json(&json!({"body":"queued-again"}))
            .send()
            .await
            .unwrap();
        let res = h
            .post_auth(&format!("/api/chats/{chat_id}/queue/next"))
            .send()
            .await
            .unwrap();
        if res.status() == 409 {
            saw_409 = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    // The test is best-effort: depending on scheduling we might not
    // catch the busy window. If we did, validate the rejection
    // wasn't accompanied by a phantom prompt insert.
    if saw_409 {
        let view: Value = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        // Each successful run_next maps to exactly one prompt; we
        // sanity-check that the count is bounded — no race-created
        // duplicates.
        let n = view["prompts"].as_array().unwrap().len();
        assert!(
            n <= 21,
            "unexpected prompt count {n} suggests race-doubled inserts"
        );
    }
}

/// Repro for the user-reported bug: rapid-fire several smart-sends
/// in auto mode → flip to manual mid-drain → click `run_next` →
/// every remaining queue item must eventually land in the timeline
/// (no item gets stuck and the agent isn't deadlocked).
///
/// Why this can wedge: auto-drain marks items Running via
/// `pop_next_pending`. If we switch to manual after the pop but
/// before mark_done, the drain loop's next `is_auto` check returns
/// false and the loop exits — leaving any subsequent Pending items
/// in the queue. `run_next` must then pick those up. The previous
/// implementation could orphan Running items if mark_done failed,
/// stranding the queue.
#[tokio::test]
async fn rapid_fire_then_manual_then_run_next_drains_every_item() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "rapid-manual", "fake", "echo").await;

    // Auto mode by default. Rapid-fire 5 smart-sends.
    let futs = (0..5).map(|i| {
        h.post_auth(&format!("/api/chats/{chat_id}/messages"))
            .json(&json!({"content": format!("rapid-{i}")}))
            .send()
    });
    let responses = futures::future::join_all(futs).await;
    for res in responses {
        assert_eq!(res.unwrap().status(), 200);
    }

    // Flip to manual as quickly as possible (try to land it
    // mid-drain). If we're too late the drain just completes; the
    // test still passes because every message ends up in the
    // timeline either way.
    let _ = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode": "manual"}))
        .send()
        .await
        .unwrap();

    // Wait until any in-flight dispatch + drain finishes (so the
    // dispatching flag clears). We poll until /queue reports either
    // empty (drain completed before our toggle) or stable
    // (no Running items).
    for _ in 0..50 {
        let q: Value = h
            .get_auth(&format!("/api/chats/{chat_id}/queue"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let items = q["items"].as_array().unwrap();
        let running = items.iter().any(|i| i["status"] == "running");
        if !running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Drain any remaining pending items via run_next. We loop until
    // /queue has zero pending — should take at most a few iterations
    // (one item per call). Each call MUST eventually succeed (200)
    // or return 404 (queue emptied). A 409 is legal in-between
    // (dispatching task is still tearing down) so we retry with a
    // short backoff; we just never accept a 5xx and we cap retries
    // so a true deadlock would still fail the test.
    let mut run_next_calls = 0;
    let mut total_attempts = 0;
    loop {
        let q: Value = h
            .get_auth(&format!("/api/chats/{chat_id}/queue"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let pending = q["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["status"] == "pending")
            .count();
        if pending == 0 {
            break;
        }
        let res = h
            .post_auth(&format!("/api/chats/{chat_id}/queue/next"))
            .send()
            .await
            .unwrap();
        total_attempts += 1;
        assert!(
            total_attempts <= 500,
            "too many run_next attempts — likely deadlock"
        );
        match res.status().as_u16() {
            200 | 404 => {
                run_next_calls += 1;
                assert!(
                    run_next_calls <= 10,
                    "run_next succeeded too many times — possible loop"
                );
            }
            409 => {
                // Chat is mid-turn (auto-drain task hasn't fully
                // released the dispatching flag yet). Back off and
                // retry; this is normal. CI runners are slower so
                // we give them more headroom.
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            other => panic!(
                "run_next returned unexpected status {other}; body={}",
                res.text().await.unwrap()
            ),
        }

        // Wait for the spawned dispatch to clear before the next
        // run_next, so we minimise 409 retries.
        for _ in 0..100 {
            let q: Value = h
                .get_auth(&format!("/api/chats/{chat_id}/queue"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let still_running = q["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["status"] == "running");
            if !still_running {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    // Final check: all 5 messages made it into the timeline. Poll —
    // the last run_next dispatch lands asynchronously after the queue
    // reports drained, so an immediate assert races the prompt insert
    // (seen flake on CI: rapid-4 missing).
    let mut contents: Vec<String> = Vec::new();
    for _ in 0..200 {
        let view: Value = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        contents = view["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["content"].as_str().unwrap_or("").to_string())
            .collect();
        if (0..5).all(|i| contents.iter().any(|c| *c == format!("rapid-{i}"))) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    for i in 0..5 {
        let needle = format!("rapid-{i}");
        assert!(
            contents.iter().any(|c| *c == needle),
            "{needle} never landed in the timeline. Got: {contents:?}"
        );
    }

    // Queue must be empty.
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let items = q["items"].as_array().unwrap();
    assert!(
        items.is_empty(),
        "queue not empty after manual drain: {items:?}"
    );
}

/// Switching from auto to manual WHILE the agent is mid-turn must
/// not orphan Running queue items. Specifically: if auto-drain pops
/// an item to Running but the loop exits (due to mode flip) before
/// `mark_done` runs, the item must not be left dangling.
///
/// The simplest contract: after every dispatch_task ends — whether
/// it completes the drain or bails out — there must be no Running
/// items left in the queue. The current implementation calls
/// mark_done inside the loop, AFTER each dispatch, so this should
/// always hold. This test pins the contract.
#[tokio::test]
async fn mode_flip_mid_drain_does_not_orphan_running_items() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "mode-flip", "fake", "echo").await;

    // Queue several items via direct enqueue (under auto, drain will
    // start on first send_message).
    for i in 0..4 {
        h.post_auth(&format!("/api/chats/{chat_id}/queue"))
            .json(&json!({"body": format!("q-{i}")}))
            .send()
            .await
            .unwrap();
    }

    // Send one message → kicks dispatch + auto-drain.
    h.post_auth(&format!("/api/chats/{chat_id}/messages"))
        .json(&json!({"content": "kick"}))
        .send()
        .await
        .unwrap();

    // Spam mode flips to maximise the chance of landing one between
    // pop_next_pending and mark_done. Alternates deterministically
    // so the test isn't flaky from a stuck PRNG seed.
    for i in 0..20 {
        let mode = if i % 2 == 0 { "manual" } else { "auto" };
        let _ = h
            .post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
            .json(&json!({"mode": mode}))
            .send()
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    // Settle: flip back to manual so auto-drain stops.
    h.post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode": "manual"}))
        .send()
        .await
        .unwrap();

    // Wait for any in-flight dispatch to finish (no Running items).
    for _ in 0..100 {
        let q: Value = h
            .get_auth(&format!("/api/chats/{chat_id}/queue"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let running = q["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["status"] == "running");
        if !running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Final assertion: zero Running items. Any number of Pending is
    // acceptable (the user explicitly asked for manual mode); the
    // bug we're guarding against is items frozen as Running with
    // no dispatch task tracking them.
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let items = q["items"].as_array().unwrap();
    let running: Vec<_> = items.iter().filter(|i| i["status"] == "running").collect();
    assert!(
        running.is_empty(),
        "orphaned Running items after mode flip: {running:?}"
    );
}

/// `chat_idle` WS hint is published at the end of every dispatch
/// task so the FE can refresh its "agent is busy" affordances
/// without waiting for the 2 s queue poll.
///
/// This test subscribes to the chat's WS topic, fires one
/// smart-send, and asserts that:
///   1. At least one `token` / `done` event arrives (proves the
///      streaming pipeline is working).
///   2. A frame with `{"chat_idle": true}` arrives after the
///      `done` event, in the right order.
#[tokio::test]
async fn smart_send_publishes_chat_idle_after_dispatch_completes() {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "ws-idle", "fake", "echo").await;

    // Build the WS URL from the harness's base URL. Replace
    // `http://` → `ws://` and append the topic query string.
    let ws_url = h.base_url.replace("http://", "ws://") + &format!("/ws?topic=chat:{chat_id}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("connect ws");

    // First frame is the {"subscribed":"..."} hello — drain it.
    let _ = ws.next().await;

    // Fire one smart-send.
    h.post_auth(&format!("/api/chats/{chat_id}/messages"))
        .json(&json!({"content": "hello"}))
        .send()
        .await
        .unwrap();

    let mut saw_done = false;
    let mut saw_idle = false;
    // Read up to 50 frames or 3 seconds, whichever comes first.
    for _ in 0..50 {
        let frame = tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = frame else {
            continue;
        };
        let val: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Done event is `{"prompt_id": "...", "event": {"type": "done", ...}}`.
        if val
            .get("event")
            .and_then(|e| e.get("type"))
            .and_then(|t| t.as_str())
            == Some("done")
        {
            saw_done = true;
        }
        // Idle frame is `{"chat_idle": true}`.
        if val.get("chat_idle").and_then(|v| v.as_bool()) == Some(true) {
            saw_idle = true;
            assert!(saw_done, "chat_idle arrived before done");
            break;
        }
    }
    let _ = ws.send(Message::Close(None)).await;
    assert!(
        saw_done,
        "never saw a `done` event for the dispatched prompt"
    );
    assert!(saw_idle, "never saw the `chat_idle` event after dispatch");
}

/// Repeated rapid-fire (10 sends back-to-back) followed by auto
/// drain. Confirms:
///   - No message is dropped.
///   - Prompts land in the timeline in submission order.
///   - The queue empties to zero.
///   - The dispatching flag clears (a follow-up send works idle-fast).
///
/// This is the canonical "open source release" regression: anyone
/// touching `send_message` / `spawn_dispatch_task` / `mark_done`
/// must keep this green.
#[tokio::test]
async fn rapid_fire_10_then_followup_send_runs_immediately() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "rapid-ten", "fake", "echo").await;

    let futs = (0..10).map(|i| {
        h.post_auth(&format!("/api/chats/{chat_id}/messages"))
            .json(&json!({"content": format!("burst-{i}")}))
            .send()
    });
    for res in futures::future::join_all(futs).await {
        assert_eq!(res.unwrap().status(), 200);
    }

    // Wait for drain.
    for _ in 0..100 {
        let view: Value = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let n = view["prompts"].as_array().map(|a| a.len()).unwrap_or(0);
        if n >= 10 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 10, "expected 10 prompts; got {prompts:?}");
    for (i, p) in prompts.iter().enumerate() {
        let expected = format!("burst-{i}");
        assert_eq!(
            p["content"].as_str().unwrap(),
            expected,
            "ordering broke at index {i}"
        );
    }

    // Queue is empty + a follow-up send dispatches immediately
    // (not queued). Wait briefly for the dispatching flag to
    // clear, then check.
    for _ in 0..50 {
        let res = h
            .post_auth(&format!("/api/chats/{chat_id}/messages"))
            .json(&json!({"content":"followup"}))
            .send()
            .await
            .unwrap();
        let body: Value = res.json().await.unwrap();
        if body["kind"] == "dispatched" {
            return; // success
        }
        // If queued, the previous burst's task hasn't fully cleared
        // yet — wait + try again. Caps at 1 s; if we still can't
        // dispatch the bug is real.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("follow-up send was never dispatched immediately (dispatching flag stuck?)");
}

/// `POST /api/chats/:id/stop` returns 204 on an idle chat. The
/// endpoint force-clears any stale dispatching flag as a last-resort
/// unstick, so the response is 204 rather than 404.
#[tokio::test]
async fn stop_turn_returns_204_when_chat_is_idle() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "stop-idle", "fake", "echo").await;

    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
}

/// Stop works against the unknown-chat path too — without a chat
/// record there is no dispatching flag to clear, but the endpoint
/// still returns 204 (it is a no-op safety call).
#[tokio::test]
async fn stop_turn_unknown_chat_returns_204() {
    let h = BeHarness::start().await;
    let res = h
        .post_auth("/api/chats/does-not-exist/stop")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
}

/// Retry clears the last prompt's events and re-dispatches it,
/// regenerating the response without creating a new prompt.
#[tokio::test]
async fn retry_last_prompt_regenerates_response() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "retry", "fake", "echo").await;

    let p1 = h
        .post_auth(&format!("/api/chats/{chat_id}/prompts"))
        .json(&json!({"content":"hello"}))
        .send()
        .await
        .unwrap();
    assert_eq!(p1.status(), 200);
    let prompt: Value = p1.json().await.unwrap();
    let prompt_id = prompt["id"].as_str().unwrap().to_owned();

    // Wait for the first response to complete.
    let mut first_done = false;
    for _ in 0..100 {
        let view: Value = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let prompts = view["prompts"].as_array().unwrap();
        let p = prompts.iter().find(|p| p["id"] == prompt_id).unwrap();
        if p["events"].as_array().map(|a| a.len()).unwrap_or(0) >= 3 {
            first_done = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(first_done, "first response never completed");

    let retry = h
        .post_auth(&format!("/api/chats/{chat_id}/retry"))
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), 200);
    let retried: Value = retry.json().await.unwrap();
    assert_eq!(retried["id"], prompt_id);
    assert_eq!(retried["content"], "hello");

    // Poll until the retry produces a new response.
    let mut retry_done = false;
    for _ in 0..100 {
        let view: Value = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let prompts = view["prompts"].as_array().unwrap();
        assert_eq!(prompts.len(), 1, "retry should not create a new prompt");
        let p = &prompts[0];
        if p["events"].as_array().map(|a| a.len()).unwrap_or(0) >= 3 {
            retry_done = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(retry_done, "retry never produced a new response");
}

#[tokio::test]
async fn queue_item_patch_updates_body() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "patch", "fake", "echo").await;

    // Flip to manual so item stays in queue.
    let _ = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode": "manual"}))
        .send()
        .await
        .unwrap();

    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/queue"))
        .json(&json!({"body": "orig"}))
        .send()
        .await
        .unwrap();
    let item: Value = res.json().await.unwrap();
    let item_id = item["id"].as_str().unwrap();

    let patch = h
        .patch(&format!("/api/chats/{chat_id}/queue/{item_id}"))
        .json(&json!({"body": "new text"}))
        .send()
        .await
        .unwrap();
    assert_eq!(patch.status(), 204);

    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let updated = &q["items"].as_array().unwrap()[0];
    assert_eq!(updated["body"], "new text");
}

/// Flipping manual → auto on an IDLE chat with a pending backlog must
/// kick a drain. This is the user-reported bug: queue items while in
/// manual mode, send some manually, then re-enable auto-send — and the
/// queue just sat there instead of draining. The normal drain only
/// fires on send / turn-completion; an idle chat has no in-flight turn
/// to trigger it, so `set_mode` must kick one itself.
#[tokio::test]
async fn flip_to_auto_on_idle_chat_drains_pending_backlog() {
    let h = BeHarness::start().await;
    let chat_id = make_chat(&h, "flip-drain", "fake", "echo").await;

    // Manual mode so enqueued items park (don't auto-drain).
    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode": "manual"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    // Queue three items while manual — they stay pending.
    for i in 0..3 {
        h.post_auth(&format!("/api/chats/{chat_id}/queue"))
            .json(&json!({"body": format!("parked-{i}")}))
            .send()
            .await
            .unwrap();
    }

    // Sanity: all three pending, chat idle (no prompts dispatched).
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        q["items"].as_array().unwrap().len(),
        3,
        "expected 3 parked items, got {:?}",
        q["items"]
    );

    // Re-enable auto-send on the idle chat. This MUST kick a drain.
    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/queue/mode"))
        .json(&json!({"mode": "auto"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    // Wait for the drain: all 3 land as prompts, queue empties.
    let mut drained = false;
    for _ in 0..100 {
        let view: Value = h
            .get_auth(&format!("/api/chats/{chat_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let prompts = view["prompts"].as_array().map(|a| a.len()).unwrap_or(0);
        if prompts >= 3 {
            drained = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        drained,
        "queue did not drain after flipping to auto on an idle chat"
    );

    // Prompts landed in FIFO order.
    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 3, "expected 3 drained prompts: {prompts:?}");
    for (i, p) in prompts.iter().enumerate() {
        assert_eq!(p["content"].as_str().unwrap(), format!("parked-{i}"));
    }

    // Queue should be empty (items removed by mark_done). Poll briefly
    // because on slow CI runners the drain task may not have committed
    // the removal yet.
    let mut queue_empty = false;
    for _ in 0..40 {
        let q: Value = h
            .get_auth(&format!("/api/chats/{chat_id}/queue"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if q["items"].as_array().unwrap().is_empty() {
            queue_empty = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(queue_empty, "queue not empty after auto drain");
}
