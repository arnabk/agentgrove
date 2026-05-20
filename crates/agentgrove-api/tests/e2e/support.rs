//! Test harness: boot the real Axum router on an ephemeral port with a
//! tempdir SQLite DB. No auth — all helpers issue plain requests.

use agentgrove_api::{build_router, AppState};
use agentgrove_store::{open_pool, run_migrations};
use tempfile::TempDir;
use tokio::net::TcpListener;

pub struct BeHarness {
    pub base_url: String,
    pub client: reqwest::Client,
    #[allow(dead_code)]
    pub state_dir: std::path::PathBuf,
    _tmp: TempDir,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl BeHarness {
    pub async fn start() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = open_pool(tmp.path()).await.expect("pool");
        run_migrations(&pool).await.expect("migrate");

        let state = AppState::new(tmp.path().to_path_buf(), pool);
        let app = build_router(state);

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let (sd_tx, sd_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = sd_rx.await;
                })
                .await
                .expect("serve");
        });
        let base_url = format!("http://{addr}");
        let client = reqwest::Client::builder().build().expect("reqwest");
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
                    client,
                    state_dir: tmp.path().to_path_buf(),
                    _tmp: tmp,
                    _shutdown: sd_tx,
                };
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("server did not become ready");
    }

    pub fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.get(format!("{}{}", self.base_url, path))
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.post(format!("{}{}", self.base_url, path))
    }

    pub fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.delete(format!("{}{}", self.base_url, path))
    }

    // Backward-compat aliases so existing tests don't need to change.
    pub fn get_auth(&self, path: &str) -> reqwest::RequestBuilder {
        self.get(path)
    }
    pub fn get_anon(&self, path: &str) -> reqwest::RequestBuilder {
        self.get(path)
    }
    pub fn post_auth(&self, path: &str) -> reqwest::RequestBuilder {
        self.post(path)
    }
    pub fn delete_auth(&self, path: &str) -> reqwest::RequestBuilder {
        self.delete(path)
    }
}
