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
