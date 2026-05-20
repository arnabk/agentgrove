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
        .get_auth(&format!("/api/chats/{chat_id}/prompts?before=3&limit=99999"))
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

    // Fire a normal prompt. The handler dispatches it, then auto-drains
    // the queue inline before returning.
    let res = h
        .post_auth(&format!("/api/chats/{chat_id}/prompts"))
        .json(&json!({"content":"first"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    // Chat now has 3 prompts: first + alpha + beta.
    let view: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompts = view["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 3, "expected first + 2 drained, got {:?}",
        prompts.iter().map(|p| &p["content"]).collect::<Vec<_>>());
    assert_eq!(prompts[0]["content"], "first");
    assert_eq!(prompts[1]["content"], "alpha");
    assert_eq!(prompts[2]["content"], "beta");

    // Queue state: both items marked done.
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let items = q["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    for it in items {
        assert_eq!(it["status"], "done", "expected done, got {:?}", it);
    }
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
