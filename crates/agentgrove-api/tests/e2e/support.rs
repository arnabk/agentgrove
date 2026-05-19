//! Test harness: boot the real Axum router on an ephemeral port and
//! return a typed HTTP client.

use agentgrove_api::{build_router, AppState};
use tokio::net::TcpListener;

/// Live test harness.
pub struct BeHarness {
    pub base_url: String,
    pub token: String,
    pub client: reqwest::Client,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl BeHarness {
    /// Start the server in-process on an ephemeral loopback port. Returns
    /// when the listener is bound and accepting.
    pub async fn start() -> Self {
        let token = "test-token-abc123".to_string();
        let state = AppState::new(token.clone());
        let app = build_router(state);

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("serve");
        });

        let base_url = format!("http://{addr}");
        let client = reqwest::Client::builder().build().expect("reqwest client");

        // Wait for /health to respond before returning.
        for _ in 0..50 {
            if client
                .get(format!("{base_url}/health"))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
            {
                return Self {
                    base_url,
                    token,
                    client,
                    _shutdown: shutdown_tx,
                };
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("server did not become ready");
    }

    /// Build a `GET` request with the bearer token applied.
    pub fn get_auth(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.token)
    }

    /// Build a `GET` request with no auth header.
    pub fn get_anon(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.get(format!("{}{}", self.base_url, path))
    }
}
