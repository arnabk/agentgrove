//! Topic-keyed broadcast bus for streaming events to WS subscribers.
//!
//! Each topic keeps a bounded ring of the most recent N messages so a
//! subscriber that arrives slightly after the producer started still
//! receives the backlog. This matters for ephemeral flows like worktree
//! pre-scripts where the BE may publish a few stdout lines before the
//! FE's WebSocket finishes upgrading.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tokio::sync::broadcast;

/// Broadcast event payload.
#[derive(Debug, Clone)]
pub struct LogEvent {
    /// Topic key (e.g. `worktree:<id>:script`, `chat:<id>`, `term:<id>`).
    pub topic: String,
    /// JSON-encoded payload (rendered to text frame).
    pub data: String,
}

/// Per-topic state held by the bus: the broadcaster + a bounded
/// history buffer for replay on subscribe.
#[derive(Debug)]
struct TopicState {
    tx: broadcast::Sender<String>,
    history: VecDeque<String>,
}

/// Topic-multiplexed broadcaster with per-topic replay history.
/// Subscribers receive only their topic. History capacity bounds how
/// far back a late subscriber can replay.
#[derive(Debug)]
pub struct LogBus {
    inner: Mutex<HashMap<String, TopicState>>,
    /// Capacity of the broadcast::channel for live delivery.
    capacity: usize,
    /// Capacity of the per-topic replay buffer.
    history_capacity: usize,
}

impl Default for LogBus {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            capacity: 1024,
            history_capacity: 512,
        }
    }
}

impl LogBus {
    fn topic_mut<'a>(
        map: &'a mut HashMap<String, TopicState>,
        topic: &str,
        capacity: usize,
    ) -> &'a mut TopicState {
        map.entry(topic.to_owned()).or_insert_with(|| TopicState {
            tx: broadcast::channel(capacity).0,
            history: VecDeque::new(),
        })
    }

    /// Subscribe to a topic. Creates it lazily on first call. Returns
    /// the broadcast receiver plus the current history snapshot for
    /// replay. Callers should write the history out before the live
    /// stream so a late subscriber sees a coherent ordering.
    pub fn subscribe(&self, topic: &str) -> (broadcast::Receiver<String>, Vec<String>) {
        let mut map = self.inner.lock().expect("logbus mutex");
        let state = Self::topic_mut(&mut map, topic, self.capacity);
        let rx = state.tx.subscribe();
        let history = state.history.iter().cloned().collect();
        (rx, history)
    }

    /// Publish to a topic. Stores the message in the replay buffer and
    /// broadcasts to all current subscribers (no error if there are
    /// none yet — the message still sits in history for the next
    /// subscriber).
    pub fn publish(&self, topic: &str, data: impl Into<String>) {
        let s: String = data.into();
        let tx = {
            let mut map = self.inner.lock().expect("logbus mutex");
            let state = Self::topic_mut(&mut map, topic, self.capacity);
            // Evict oldest if at capacity.
            if state.history.len() >= self.history_capacity {
                state.history.pop_front();
            }
            state.history.push_back(s.clone());
            state.tx.clone()
        };
        let _ = tx.send(s);
    }

    /// Drop the replay history for a topic. Used when a flow is known
    /// to be complete so we don't accumulate stale buffers forever.
    /// The broadcast channel itself is left in place in case any
    /// receivers are still attached.
    pub fn clear_history(&self, topic: &str) {
        let mut map = self.inner.lock().expect("logbus mutex");
        if let Some(state) = map.get_mut(topic) {
            state.history.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscriber_receives_published_message() {
        let bus = LogBus::default();
        let (mut rx, _) = bus.subscribe("t1");
        bus.publish("t1", "hello".to_string());
        let msg = rx.recv().await.unwrap();
        assert_eq!(msg, "hello");
    }

    #[tokio::test]
    async fn topics_are_isolated() {
        let bus = LogBus::default();
        let (mut rx_a, _) = bus.subscribe("a");
        let (_rx_b, _) = bus.subscribe("b");
        bus.publish("b", "for-b".to_string());
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        assert!(rx_a.try_recv().is_err());
    }

    #[tokio::test]
    async fn late_subscriber_replays_history() {
        let bus = LogBus::default();
        bus.publish("t1", "one".to_string());
        bus.publish("t1", "two".to_string());
        let (_, history) = bus.subscribe("t1");
        assert_eq!(history, vec!["one", "two"]);
    }

    #[tokio::test]
    async fn history_is_bounded() {
        let mut bus = LogBus::default();
        bus.history_capacity = 3;
        for i in 0..10 {
            bus.publish("t", format!("msg{i}"));
        }
        let (_, history) = bus.subscribe("t");
        assert_eq!(history, vec!["msg7", "msg8", "msg9"]);
    }

    #[tokio::test]
    async fn clear_history_drops_replay_only() {
        let bus = LogBus::default();
        bus.publish("t", "a".to_string());
        let (mut rx, history) = bus.subscribe("t");
        assert_eq!(history, vec!["a"]);
        bus.clear_history("t");
        // New subscriber after clear gets empty history.
        let (_, fresh_history) = bus.subscribe("t");
        assert!(fresh_history.is_empty());
        // Existing subscriber's pending messages remain.
        bus.publish("t", "b".to_string());
        let msg = rx.recv().await.unwrap();
        assert_eq!(msg, "b");
    }
}
