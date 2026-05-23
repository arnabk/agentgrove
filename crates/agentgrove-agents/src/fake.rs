//! Deterministic in-process provider used by tests. Emits a scripted
//! sequence of [`AgentEvent`]s and ignores the prompt and cwd.

use crate::{
    AgentEvent, AgentProvider, ProviderDescriptor, ProviderError, ProviderId, SpawnOptions,
};
use async_trait::async_trait;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Test-only provider. Construct with [`FakeProvider::with_script`] to
/// pre-script the events emitted on the next `spawn` call.
#[derive(Debug, Default, Clone)]
pub struct FakeProvider {
    script: Arc<Mutex<Vec<AgentEvent>>>,
}

impl FakeProvider {
    /// Construct a provider that will emit `events` (in order) the
    /// next time `spawn` is called.
    #[must_use]
    pub fn with_script(events: Vec<AgentEvent>) -> Self {
        Self {
            script: Arc::new(Mutex::new(events)),
        }
    }

    /// Construct a provider with a sensible default script: echo
    /// the prompt back as a Token event + a terminal Done. Useful
    /// for live e2e suites where the BE registers FakeProvider
    /// via AGENTGROVE_ENABLE_FAKE=1 and tests want a fast,
    /// network-free agent turn.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl AgentProvider for FakeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Fake
    }

    async fn detect(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: ProviderId::Fake,
            label: "Fake".to_string(),
            available: true,
            path: None,
            version: Some("test".into()),
            default_model: "echo".to_string(),
            models: vec!["echo".to_string()],
            supports_resume: false,
        }
    }

    async fn spawn(
        &self,
        prompt: &str,
        _opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> {
        let script: Vec<AgentEvent> = {
            let mut guard = self.script.lock().expect("fake provider mutex");
            std::mem::take(&mut *guard)
        };
        if script.is_empty() {
            // Default behaviour for the env-gated production-FE
            // fake provider: deterministic two-event response that
            // echoes the prompt and immediately settles. Lets the
            // FE auto-drain path complete without hanging.
            let _ = events.send(AgentEvent::Token {
                text: format!("[fake] {prompt}"),
            });
            let _ = events.send(AgentEvent::Done {
                result: Some(format!("[fake] {prompt}")),
                cost_usd: None,
            });
        } else {
            for ev in script {
                let _ = events.send(ev);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_provider_emits_scripted_events_in_order() {
        let script = vec![
            AgentEvent::SessionStart {
                session_id: "s1".into(),
            },
            AgentEvent::Token { text: "hi".into() },
            AgentEvent::Done {
                result: Some("hi".into()),
                cost_usd: None,
            },
        ];
        let p = FakeProvider::with_script(script.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        p.spawn("ignored", SpawnOptions::default(), tx)
            .await
            .unwrap();
        let mut got = Vec::new();
        while let Some(ev) = rx.recv().await {
            got.push(ev);
        }
        assert_eq!(got, script);
    }
}
