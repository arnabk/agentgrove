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

    pub fn patch(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.patch(format!("{}{}", self.base_url, path))
    }

    pub fn put(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.put(format!("{}{}", self.base_url, path))
    }

    /// Simulate a server restart by tearing down the current Axum
    /// instance and spinning up a fresh one against the same
    /// `state_dir` + SQLite database. Used by persistence tests to
    /// prove that chats / queue / layout survive a process bounce.
    pub async fn restart(self) -> Self {
        // Take owned references to the persistent state we need to
        // preserve. `_tmp` keeps the tempdir alive across the new
        // instance; `_shutdown` is dropped, which fires the
        // graceful-shutdown future on the old server.
        let Self {
            state_dir,
            _tmp,
            _shutdown,
            ..
        } = self;
        drop(_shutdown);
        // Give the old server a moment to release the listening port.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let pool = open_pool(&state_dir).await.expect("pool");
        run_migrations(&pool).await.expect("migrate");
        let state = AppState::new(state_dir.clone(), pool);
        // Replay the same startup recovery + hydration steps the
        // real binary runs so this restart matches production.
        let _ = state.worktrees.recover_stale_lifecycle().await;
        let _ = state.queue_store.recover_stale_running().await;
        agentgrove_api::chats::hydrate_from_store(&state).await;
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
                    state_dir,
                    _tmp,
                    _shutdown: sd_tx,
                };
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("restarted server did not become ready");
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
