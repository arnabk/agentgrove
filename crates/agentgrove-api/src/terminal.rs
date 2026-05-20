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

    // No cap: users can open as many terminals as they want.
    state
        .terminals
        .spawn(
            body.cwd.as_deref(),
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

pub async fn history(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<String, StatusCode> {
    state.terminals.history(&id).ok_or(StatusCode::NOT_FOUND)
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
