//! E2E for per-chat recurring messages.

use crate::support::BeHarness;
use serde_json::{json, Value};

async fn new_chat(h: &BeHarness) -> String {
    let chat: Value = h
        .post_auth("/api/worktrees/wt-sched/chats")
        .json(&json!({"title":"s","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    chat["id"].as_str().unwrap().to_owned()
}

async fn prompt_count(h: &BeHarness, chat_id: &str) -> usize {
    let v: Value = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["prompts"].as_array().unwrap().len()
}

#[tokio::test]
async fn schedule_crud_validation_and_firing() {
    let h = BeHarness::start().await;
    let chat_id = new_chat(&h).await;
    let base = format!("/api/chats/{chat_id}/schedules");

    // Validation: too-short interval, empty body, both modes at once,
    // neither mode, past time, unknown chat.
    for (body, code) in [
        (json!({"body":"hi","interval_secs":5}), 400),
        (json!({"body":"  ","interval_secs":60}), 400),
        (
            json!({"body":"hi","interval_secs":60,"next_run_at":4_000_000_000_000i64}),
            400,
        ),
        (json!({"body":"hi"}), 400),
        (json!({"body":"hi","next_run_at":1_000_000_000_000i64}), 400),
    ] {
        let r = h.post_auth(&base).json(&body).send().await.unwrap();
        assert_eq!(r.status(), code);
    }
    let r = h
        .post_auth("/api/chats/nope/schedules")
        .json(&json!({"body":"hi","interval_secs":60}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);

    // Create.
    let s: Value = h
        .post_auth(&base)
        .json(&json!({"body":"status check","interval_secs":60}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = s["id"].as_str().unwrap().to_owned();
    assert_eq!(s["enabled"], true);
    assert!(s["last_run_at"].is_null());
    let first_due = s["next_run_at"].as_i64().unwrap();

    // Not due yet: nothing sent.
    agentgrove_api::schedules::fire_due(&h.state, first_due - 1).await;
    assert_eq!(prompt_count(&h, &chat_id).await, 0);

    // Due, fired 4s late (tick lag): one message sent, and the next run
    // stays on the original cadence instead of slipping by 4s.
    agentgrove_api::schedules::fire_due(&h.state, first_due + 4_000).await;
    assert_eq!(prompt_count(&h, &chat_id).await, 1);
    let list: Value = h
        .get_auth(&base)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list[0]["last_run_at"].as_i64(), Some(first_due + 4_000));
    assert_eq!(list[0]["next_run_at"].as_i64(), Some(first_due + 60_000));

    // Chat busy: the copy queues once, and the next fire doesn't add a
    // second copy while the first is still waiting. Wait for the first
    // run's turn to finish so its cleanup can't clear our busy flag.
    for _ in 0..100 {
        if !h.state.dispatching.lock().await.contains(&chat_id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    h.state.dispatching.lock().await.insert(chat_id.clone());
    agentgrove_api::schedules::fire_due(&h.state, first_due + 60_000).await;
    agentgrove_api::schedules::fire_due(&h.state, first_due + 120_000).await;
    let q: Value = h
        .get_auth(&format!("/api/chats/{chat_id}/queue"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(q["items"].as_array().unwrap().len(), 1);
    h.state.dispatching.lock().await.remove(&chat_id);

    // Paused: does not fire even when overdue.
    let r = h
        .patch(&format!("{base}/{id}"))
        .json(&json!({"enabled":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    agentgrove_api::schedules::fire_due(&h.state, first_due + 10 * 60_000).await;
    assert_eq!(prompt_count(&h, &chat_id).await, 1);

    // Edit + delete.
    let r: Value = h
        .patch(&format!("{base}/{id}"))
        .json(&json!({"body":"new text","interval_secs":3600}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r["body"], "new text");
    assert_eq!(r["interval_secs"], 3600);
    let r = h.delete_auth(&format!("{base}/{id}")).send().await.unwrap();
    assert_eq!(r.status(), 204);
    let list: Value = h
        .get_auth(&base)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(list.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn one_time_schedule_fires_once_and_disables() {
    let h = BeHarness::start().await;
    let chat_id = new_chat(&h).await;
    let base = format!("/api/chats/{chat_id}/schedules");
    let at = chrono::Utc::now().timestamp_millis() + 30_000;

    let s: Value = h
        .post_auth(&base)
        .json(&json!({"body":"once only","next_run_at":at}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["interval_secs"], Value::Null);

    // Fires exactly once, then disables itself; later ticks do nothing.
    agentgrove_api::schedules::fire_due(&h.state, at).await;
    for _ in 0..100 {
        if !h.state.dispatching.lock().await.contains(&chat_id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    agentgrove_api::schedules::fire_due(&h.state, at + 86_400_000).await;
    assert_eq!(prompt_count(&h, &chat_id).await, 1);

    let list: Value = h
        .get_auth(&base)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list[0]["enabled"], false);
    assert!(!list[0]["last_run_at"].is_null());
}
