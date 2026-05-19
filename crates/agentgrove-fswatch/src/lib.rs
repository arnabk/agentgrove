//! Debounced filesystem watcher.
//!
//! M0 scope: confirms `notify` can construct a recommended watcher on
//! every supported OS. Full per-worktree watcher with snapshot capture
//! lands in M4.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use notify::{recommended_watcher, Watcher};

/// Construct the platform's recommended watcher and immediately drop it.
///
/// # Errors
///
/// Propagates errors from `notify` when no watcher backend is available.
pub fn smoke_recommended_watcher() -> notify::Result<()> {
    let _watcher = recommended_watcher(|_res: notify::Result<notify::Event>| {})?;
    let _: &dyn Watcher = &_watcher;
    Ok(())
}
