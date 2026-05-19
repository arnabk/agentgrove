//! PTY session manager.
//!
//! M0 scope: opens a PTY in tests on every OS to prove `portable-pty` is
//! wired correctly. Full session manager (resize, scrollback, mux) lands
//! in M2.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use portable_pty::{native_pty_system, PtySize};

/// Open a 24x80 PTY pair and immediately drop it. Useful as a runtime
/// smoke check that the host supports PTY allocation (ConPTY on Windows
/// 1809+, openpty on Unix).
///
/// # Errors
///
/// Propagates the underlying `portable-pty` error if PTY allocation fails.
pub fn smoke_open() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let pty_system = native_pty_system();
    let _pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    Ok(())
}
