//! Cross-provider model list cache.
//!
//! Provider CLIs / HTTP endpoints that expose a "list models" surface
//! (opencode `opencode models`, 9router `GET /v1/models`) can return
//! dozens of entries that change over time as the user installs new
//! upstream providers. Hitting the underlying surface on every
//! `GET /api/providers` call would be slow and could ping a remote
//! HTTP endpoint per dialog open.
//!
//! This module is a tiny in-memory cache keyed by [`ProviderId`] with
//! a 5-minute TTL plus a manual [`invalidate`] hook. Providers read
//! it inside `detect()` via [`get_or_fetch`], handing in an async
//! closure that knows how to fetch fresh data when the cache misses.
//!
//! The cache is intentionally NOT persisted: a server restart should
//! re-probe (model lists drift quickly and we'd rather pay a one-off
//! 200ms on first request than serve stale entries from disk).

use crate::ProviderId;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Default time-to-live for a cached entry. Tuned so that opening
/// the new-chat dialog a few times in quick succession reuses the
/// same fetch, but a user who installs a new model upstream sees it
/// within ~5 minutes without manually hitting refresh.
pub const DEFAULT_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
struct Entry {
    models: Vec<String>,
    fetched_at: Instant,
}

/// Singleton cache. `Mutex` over `HashMap` is enough — fetches are
/// rare (a few per minute at peak) and contention is negligible.
/// Using `std::sync::Mutex` (not tokio's) keeps the lock zero-cost
/// when held across a few map ops; the actual async fetch happens
/// outside the lock to avoid blocking other providers' lookups.
fn cache() -> &'static Mutex<HashMap<ProviderId, Entry>> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<HashMap<ProviderId, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return the cached model list for `id` if it exists and is younger
/// than `ttl`; otherwise invoke `fetch` and store the result. The
/// fetch closure runs OUTSIDE the cache lock so concurrent calls for
/// different providers don't serialise.
///
/// `fetch` returning `Err` (or an empty list) is treated as a soft
/// failure: we DO NOT cache empty results, and the previous entry
/// (even if stale) is kept so the FE keeps showing the last known
/// good list. Callers can decide whether to surface the error or
/// fall back to a curated default by checking the returned slice.
pub async fn get_or_fetch<F, Fut>(id: ProviderId, ttl: Duration, fetch: F) -> Vec<String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<String>, String>>,
{
    // Fast path: read under the lock, drop the guard before the
    // (potentially-slow) fetch.
    {
        let guard = cache().lock().expect("models cache lock poisoned");
        if let Some(entry) = guard.get(&id) {
            if entry.fetched_at.elapsed() < ttl {
                return entry.models.clone();
            }
        }
    }
    match fetch().await {
        Ok(models) if !models.is_empty() => {
            let mut guard = cache().lock().expect("models cache lock poisoned");
            guard.insert(
                id,
                Entry {
                    models: models.clone(),
                    fetched_at: Instant::now(),
                },
            );
            models
        }
        Ok(_) => {
            // Empty list — keep whatever we had previously (might be
            // empty too, that's fine). Don't poison the cache with
            // an empty entry.
            cache()
                .lock()
                .expect("models cache lock poisoned")
                .get(&id)
                .map(|e| e.models.clone())
                .unwrap_or_default()
        }
        Err(e) => {
            tracing::warn!(
                provider = %id.as_str(),
                error = %e,
                "models live-fetch failed; falling back to cached entry"
            );
            cache()
                .lock()
                .expect("models cache lock poisoned")
                .get(&id)
                .map(|e| e.models.clone())
                .unwrap_or_default()
        }
    }
}

/// Drop the cached entry for `id` so the next [`get_or_fetch`] call
/// forces a fresh fetch. Used by the manual refresh endpoint.
pub fn invalidate(id: ProviderId) {
    let mut guard = cache().lock().expect("models cache lock poisoned");
    guard.remove(&id);
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;

    /// Tests share the process-global cache, so we serialise them
    /// behind a Mutex to avoid races on the `ProviderId::Fake` slot.
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::OnceLock;
        static M: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
        // Recover from a previous test panicking while holding the
        // lock — the cache itself is fine, we just want sequential
        // access.
        M.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    #[tokio::test]
    async fn fetch_runs_once_then_cache_hits() {
        let _g = lock();
        // Cache is process-global; use a fresh provider id per test
        // by clearing it first.
        invalidate(ProviderId::Fake);
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let c1 = counter.clone();
        let first = get_or_fetch(ProviderId::Fake, DEFAULT_TTL, move || {
            let c = c1.clone();
            async move {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(vec!["a".into(), "b".into()])
            }
        })
        .await;
        assert_eq!(first, vec!["a".to_string(), "b".to_string()]);

        let c2 = counter.clone();
        let second = get_or_fetch(ProviderId::Fake, DEFAULT_TTL, move || {
            let c = c2.clone();
            async move {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(vec!["should-not-be-used".into()])
            }
        })
        .await;
        assert_eq!(second, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
        invalidate(ProviderId::Fake);
    }

    #[tokio::test]
    async fn invalidate_forces_refetch() {
        let _g = lock();
        invalidate(ProviderId::Fake);
        let _ = get_or_fetch(ProviderId::Fake, DEFAULT_TTL, || async {
            Ok(vec!["v1".into()])
        })
        .await;
        invalidate(ProviderId::Fake);
        let after = get_or_fetch(ProviderId::Fake, DEFAULT_TTL, || async {
            Ok(vec!["v2".into()])
        })
        .await;
        assert_eq!(after, vec!["v2".to_string()]);
        invalidate(ProviderId::Fake);
    }

    #[tokio::test]
    async fn fetch_error_returns_previous_cached_entry() {
        let _g = lock();
        invalidate(ProviderId::Fake);
        let _ = get_or_fetch(ProviderId::Fake, DEFAULT_TTL, || async {
            Ok(vec!["good".into()])
        })
        .await;
        // Force expiry by passing zero TTL so next call re-fetches.
        let after = get_or_fetch(ProviderId::Fake, Duration::from_secs(0), || async {
            Err("boom".to_string())
        })
        .await;
        assert_eq!(after, vec!["good".to_string()]);
        invalidate(ProviderId::Fake);
    }
}
