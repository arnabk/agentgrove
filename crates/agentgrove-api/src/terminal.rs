//! Terminal session manager. Wraps `portable-pty` and exposes spawn /
//! write / resize / kill / read-history / status operations.
//!
//! When the shell exits (e.g. `Ctrl+D` or `exit`), the PTY reader sees
//! EOF; we mark the session `exited` so the UI can render it as ended
//! and let the user close the tab.

use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTerminalBody {
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Owning project (informational; no longer used to cap creation).
    pub project_id: Option<String>,
    /// Optional owning worktree.
    pub worktree_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TerminalDto {
    pub id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    /// True when the underlying shell has exited (PTY closed).
    pub exited: bool,
}

#[derive(Debug, Deserialize)]
pub struct WriteBody {
    pub data: String,
}

#[derive(Debug, Deserialize)]
pub struct ResizeBody {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
pub struct TerminalStatusDto {
    pub id: String,
    pub exited: bool,
}

/// Wire shape for the delta-history endpoint. The FE keeps a
/// running `lastBytes` counter and sends it as `?since=N`; the BE
/// returns ONLY the bytes after that offset (or "" when no new
/// data arrived since the last poll) plus the new total + exit
/// flag. Combining history + status into one round-trip halves
/// the per-tick HTTP cost.
#[derive(Debug, Serialize)]
pub struct HistoryDelta {
    /// Bytes appended to the PTY ring since `since`. Empty string
    /// when there's nothing new (common no-op path on idle shells).
    pub bytes: String,
    /// Current total byte count in the ring. FE adopts this as
    /// its next `since` value. May be SMALLER than `since` if the
    /// caller has stale state from a different session id, but
    /// callers should not see that in practice.
    pub total: usize,
    /// Whether the shell has exited. Piggybacks on the history
    /// poll so the FE can drop the separate status poll entirely.
    pub exited: bool,
}

pub struct Session {
    cwd: String,
    cols: Mutex<u16>,
    rows: Mutex<u16>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    history: Mutex<Vec<u8>>,
    project_id: Option<String>,
    worktree_id: Option<String>,
    /// Set when the PTY reader sees EOF (shell exit / `Ctrl+D`).
    exited: AtomicBool,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalManager {
    /// Count live sessions belonging to a project (kept for diagnostics
    /// + tests; no longer used to gate creation).
    pub fn count_for_project(&self, project_id: &str) -> usize {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.project_id.as_deref() == Some(project_id))
            .count()
    }

    pub fn spawn(
        &self,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        project_id: Option<String>,
        worktree_id: Option<String>,
    ) -> Result<TerminalDto, std::io::Error> {
        let cwd = cwd
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()));
        let pty = native_pty_system()
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(windows) {
                "cmd".into()
            } else {
                "/bin/sh".into()
            }
        });
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(&cwd);
        let child = pty
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let mut reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let session = Arc::new(Session {
            cwd: cwd.to_string_lossy().into_owned(),
            cols: Mutex::new(cols),
            rows: Mutex::new(rows),
            writer: Mutex::new(writer),
            master: Mutex::new(pty.master),
            child: Mutex::new(child),
            history: Mutex::new(Vec::with_capacity(8192)),
            project_id: project_id.clone(),
            worktree_id: worktree_id.clone(),
            exited: AtomicBool::new(false),
        });

        let id = Uuid::now_v7().to_string();
        let sess_for_reader = session.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — shell exited
                    Ok(n) => {
                        let mut h = sess_for_reader.history.lock().unwrap();
                        h.extend_from_slice(&buf[..n]);
                        if h.len() > 200_000 {
                            let drop = h.len() - 200_000;
                            h.drain(..drop);
                        }
                    }
                    Err(_) => break,
                }
            }
            // PTY reader returned — the shell has ended.
            sess_for_reader.exited.store(true, Ordering::SeqCst);
        });

        // Independent child-waiter thread. The PTY master reader can
        // sit blocked in `read()` long after the child has died (the
        // OS may not signal EOF on the master fd until all writers
        // are released, which depends on libc behaviour + the
        // platform's pty driver). Polling `child.try_wait()` in a
        // separate thread guarantees we flip `exited` as soon as the
        // shell process is actually gone (Ctrl+D in zsh / `exit` /
        // process killed externally), so the FE auto-close fires
        // without relying on the reader to also unblock.
        let sess_for_waiter = session.clone();
        std::thread::spawn(move || {
            loop {
                {
                    let mut child = sess_for_waiter.child.lock().unwrap();
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            sess_for_waiter.exited.store(true, Ordering::SeqCst);
                            return;
                        }
                        Ok(None) => {} // still running
                        Err(_) => {
                            // Errors here usually mean the child handle
                            // is unusable; treat as exited to avoid a
                            // zombie session row.
                            sess_for_waiter.exited.store(true, Ordering::SeqCst);
                            return;
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });

        let dto = TerminalDto {
            id: id.clone(),
            cwd: session.cwd.clone(),
            cols,
            rows,
            project_id,
            worktree_id,
            exited: false,
        };
        self.sessions.lock().unwrap().insert(id, session);
        Ok(dto)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Option<()> {
        let map = self.sessions.lock().unwrap();
        let sess = map.get(id)?.clone();
        drop(map);
        let _ = sess.writer.lock().unwrap().write_all(data);
        Some(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Option<()> {
        let map = self.sessions.lock().unwrap();
        let sess = map.get(id)?.clone();
        drop(map);
        *sess.cols.lock().unwrap() = cols;
        *sess.rows.lock().unwrap() = rows;
        let _ = sess.master.lock().unwrap().resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        });
        Some(())
    }

    pub fn kill(&self, id: &str) -> Option<()> {
        let mut map = self.sessions.lock().unwrap();
        let sess = map.remove(id)?;
        let _ = sess.child.lock().unwrap().kill();
        sess.exited.store(true, Ordering::SeqCst);
        Some(())
    }

    pub fn history(&self, id: &str) -> Option<String> {
        let map = self.sessions.lock().unwrap();
        let sess = map.get(id)?.clone();
        drop(map);
        let h = sess.history.lock().unwrap();
        Some(String::from_utf8_lossy(&h).into_owned())
    }

    /// Delta-aware history fetch. Returns only the bytes appended
    /// after `since` (the caller's last-known byte count) plus the
    /// current total + exit flag. This is what every fast-tick FE
    /// poll uses — without it we'd ship the entire scrollback over
    /// HTTP every 200 ms, which made the terminal feel laggy on
    /// long-running shells (200 KB cap × 5 polls/sec = 1 MB/s).
    ///
    /// `since` is interpreted as a byte offset into the ring
    /// buffer's logical history. The ring drops oldest bytes once
    /// it exceeds 200 KB, so an old `since` can fall off the
    /// front; we handle that by returning the WHOLE current buffer
    /// and a `total` the FE can adopt verbatim (the visual cost is
    /// a one-time redraw, which is unavoidable when we've lost
    /// scrollback).
    pub fn history_since(&self, id: &str, since: usize) -> Option<HistoryDelta> {
        let map = self.sessions.lock().unwrap();
        let sess = map.get(id)?.clone();
        drop(map);
        let h = sess.history.lock().unwrap();
        let total = h.len();
        let bytes = if since >= total {
            // FE already has everything; common no-op path.
            String::new()
        } else {
            // `since` is a byte offset, not a char boundary — slicing
            // mid-UTF-8 is fine because we re-decode lossily.
            String::from_utf8_lossy(&h[since..]).into_owned()
        };
        Some(HistoryDelta {
            bytes,
            total,
            exited: sess.exited.load(Ordering::SeqCst),
        })
    }

    pub fn status(&self, id: &str) -> Option<TerminalStatusDto> {
        let map = self.sessions.lock().unwrap();
        let sess = map.get(id)?.clone();
        drop(map);
        Some(TerminalStatusDto {
            id: id.to_owned(),
            exited: sess.exited.load(Ordering::SeqCst),
        })
    }

    pub fn list(&self) -> Vec<TerminalDto> {
        let map = self.sessions.lock().unwrap();
        map.iter()
            .map(|(id, s)| TerminalDto {
                id: id.clone(),
                cwd: s.cwd.clone(),
                cols: *s.cols.lock().unwrap(),
                rows: *s.rows.lock().unwrap(),
                project_id: s.project_id.clone(),
                worktree_id: s.worktree_id.clone(),
                exited: s.exited.load(Ordering::SeqCst),
            })
            .collect()
    }

    /// Collect (terminal_id, pid) for every live PTY whose child has an
    /// OS-level PID. Used by the memory diagnostics endpoint.
    pub fn child_pids(&self) -> Vec<(String, u32)> {
        let map = self.sessions.lock().unwrap();
        let mut out = Vec::new();
        for (id, sess) in map.iter() {
            if let Ok(child) = sess.child.lock() {
                if let Some(pid) = child.process_id() {
                    out.push((id.clone(), pid));
                }
            }
        }
        out
    }
}

// ---- HTTP handlers ------------------------------------------------------

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateTerminalBody>,
) -> Result<Json<TerminalDto>, (StatusCode, String)> {
    let cols = body.cols.unwrap_or(80);
    let rows = body.rows.unwrap_or(24);

    // Resolve cwd from `worktree_id` > `project_id` > explicit `cwd` >
    // server process dir (in that order). The FE relies on the BE for
    // this because it doesn't know either path on disk — it only
    // knows the ids. Without this, every terminal opened from the
    // LeftRail would land in the agentgrove server's working
    // directory, which is wrong for both project rows and worktree
    // rows.
    let resolved_cwd: Option<String> = if let Some(wt_id) = body.worktree_id.as_deref() {
        match state.worktrees.get(wt_id).await {
            Ok(wt) => Some(wt.path.to_string_lossy().into_owned()),
            Err(e) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("worktree {wt_id} not found: {e}"),
                ));
            }
        }
    } else if let Some(pid) = body.project_id.as_deref() {
        match state.projects.get(pid).await {
            Ok(p) => Some(p.root.to_string_lossy().into_owned()),
            Err(e) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("project {pid} not found: {e}"),
                ));
            }
        }
    } else {
        body.cwd.clone()
    };

    // No cap: users can open as many terminals as they want.
    state
        .terminals
        .spawn(
            resolved_cwd.as_deref(),
            cols,
            rows,
            body.project_id,
            body.worktree_id,
        )
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub async fn list(State(state): State<AppState>) -> Json<Vec<TerminalDto>> {
    Json(state.terminals.list())
}

pub async fn write(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<WriteBody>,
) -> Result<StatusCode, StatusCode> {
    state
        .terminals
        .write(&id, body.data.as_bytes())
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn resize(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ResizeBody>,
) -> Result<StatusCode, StatusCode> {
    state
        .terminals
        .resize(&id, body.cols, body.rows)
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    state.terminals.kill(&id).ok_or(StatusCode::NOT_FOUND)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Query string for `GET /api/terminals/:id/history`. When `since`
/// is omitted (or zero) the response carries the entire current
/// ring buffer — same shape every poll, so the FE can always use
/// the same code path.
#[derive(Debug, Deserialize, Default)]
pub struct HistoryQuery {
    /// Byte offset the caller already has; only bytes after this
    /// are returned in `bytes`. See [`HistoryDelta`].
    #[serde(default)]
    pub since: Option<usize>,
}

pub async fn history(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<HistoryQuery>,
) -> Result<Json<HistoryDelta>, StatusCode> {
    state
        .terminals
        .history_since(&id, q.since.unwrap_or(0))
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

pub async fn status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TerminalStatusDto>, StatusCode> {
    state
        .terminals
        .status(&id)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
