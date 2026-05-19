//! Topic-keyed broadcast bus for streaming events to WS subscribers.

use std::collections::HashMap;
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

/// Topic-multiplexed broadcaster. Subscribers receive only their topic.
#[derive(Debug)]
pub struct LogBus {
    inner: Mutex<HashMap<String, broadcast::Sender<String>>>,
    capacity: usize,
}

impl Default for LogBus {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            capacity: 1024,
        }
    }
}

impl LogBus {
    /// Subscribe to a topic. Creates it lazily on first call.
    pub fn subscribe(&self, topic: &str) -> broadcast::Receiver<String> {
        let mut map = self.inner.lock().expect("logbus mutex");
        map.entry(topic.to_owned())
            .or_insert_with(|| broadcast::channel(self.capacity).0)
            .subscribe()
    }

    /// Publish to a topic. Drops the event if no subscribers yet.
    pub fn publish(&self, topic: &str, data: impl Into<String>) {
        let tx = {
            let mut map = self.inner.lock().expect("logbus mutex");
            map.entry(topic.to_owned())
                .or_insert_with(|| broadcast::channel(self.capacity).0)
                .clone()
        };
        let _ = tx.send(data.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscriber_receives_published_message() {
        let bus = LogBus::default();
        let mut rx = bus.subscribe("t1");
        bus.publish("t1", "hello".to_string());
        let msg = rx.recv().await.unwrap();
        assert_eq!(msg, "hello");
    }

    #[tokio::test]
    async fn topics_are_isolated() {
        let bus = LogBus::default();
        let mut rx_a = bus.subscribe("a");
        let _rx_b = bus.subscribe("b");
        bus.publish("b", "for-b".to_string());
        // give the receiver no chance to see it
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        assert!(rx_a.try_recv().is_err());
    }
}
