//! Component tests for `QueueRepo` reorder + out-of-order dispatch.

use agentgrove_store::{open_pool, run_migrations, QueueMode, QueueRepo, QueueStatus};
use tempfile::tempdir;

async fn seed() -> (tempfile::TempDir, QueueRepo) {
    let dir = tempdir().unwrap();
    let pool = open_pool(dir.path()).await.unwrap();
    run_migrations(&pool).await.unwrap();
    (dir, QueueRepo::new(pool))
}

#[tokio::test]
async fn pop_specific_pending_pops_a_middle_item() {
    let (_d, q) = seed().await;
    let chat = "chat-1";
    let a = q.enqueue(chat, "a").await.unwrap();
    let b = q.enqueue(chat, "b").await.unwrap();
    let c = q.enqueue(chat, "c").await.unwrap();

    // Pop the middle item out of order.
    let popped = q.pop_specific_pending(chat, &b.id).await.unwrap().unwrap();
    assert_eq!(popped.id, b.id);
    assert_eq!(popped.status, QueueStatus::Running);

    // a and c remain pending; b is running.
    let items = q.list(chat).await.unwrap();
    let by_id = |id: &str| items.iter().find(|i| i.id == id).unwrap().status;
    assert_eq!(by_id(&a.id), QueueStatus::Pending);
    assert_eq!(by_id(&b.id), QueueStatus::Running);
    assert_eq!(by_id(&c.id), QueueStatus::Pending);
}

#[tokio::test]
async fn pop_specific_pending_rejects_wrong_chat_or_missing() {
    let (_d, q) = seed().await;
    let a = q.enqueue("chat-1", "a").await.unwrap();
    // Wrong chat.
    assert!(q
        .pop_specific_pending("chat-2", &a.id)
        .await
        .unwrap()
        .is_none());
    // Missing id.
    assert!(q
        .pop_specific_pending("chat-1", "nope")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn reorder_changes_drain_order() {
    let (_d, q) = seed().await;
    let chat = "chat-1";
    let a = q.enqueue(chat, "a").await.unwrap();
    let b = q.enqueue(chat, "b").await.unwrap();
    let c = q.enqueue(chat, "c").await.unwrap();

    // Reverse the order: c, b, a.
    q.reorder(chat, &[c.id.clone(), b.id.clone(), a.id.clone()])
        .await
        .unwrap();

    let ids: Vec<String> = q.list(chat).await.unwrap().into_iter().map(|i| i.id).collect();
    assert_eq!(ids, vec![c.id.clone(), b.id.clone(), a.id.clone()]);

    // The head now pops as c.
    let head = q.pop_next_pending(chat).await.unwrap().unwrap();
    assert_eq!(head.id, c.id);
}

#[tokio::test]
async fn reorder_ignores_unknown_ids_and_keeps_omitted_after() {
    let (_d, q) = seed().await;
    let chat = "chat-1";
    let a = q.enqueue(chat, "a").await.unwrap();
    let b = q.enqueue(chat, "b").await.unwrap();
    let c = q.enqueue(chat, "c").await.unwrap();

    // Only mention b (+ an unknown id). b moves to the front; a, c keep
    // their relative order after it.
    q.reorder(chat, &[b.id.clone(), "ghost".into()])
        .await
        .unwrap();

    let ids: Vec<String> = q.list(chat).await.unwrap().into_iter().map(|i| i.id).collect();
    assert_eq!(ids, vec![b.id.clone(), a.id.clone(), c.id.clone()]);
}

#[tokio::test]
async fn mode_defaults_to_manual_and_roundtrips() {
    let (_d, q) = seed().await;
    assert_eq!(q.get_mode("fresh").await.unwrap(), QueueMode::Manual);
    q.set_mode("fresh", QueueMode::Auto).await.unwrap();
    assert_eq!(q.get_mode("fresh").await.unwrap(), QueueMode::Auto);
}
