//! Terminal session manager. Wraps `portable-pty` and exposes spawn /
//! write / resize / kill / read-history operations.

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
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTerminalBody {
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Serialize)]
pub struct TerminalDto {
    pub id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
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

pub struct Session {
    cwd: String,
    cols: Mutex<u16>,
    rows: Mutex<u16>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    history: Mutex<Vec<u8>>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalManager {
    pub fn spawn(
        &self,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
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
        });

        let id = Uuid::now_v7().to_string();
        let sess_for_reader = session.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
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
        });

        let dto = TerminalDto {
            id: id.clone(),
            cwd: session.cwd.clone(),
            cols,
            rows,
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
        Some(())
    }

    pub fn history(&self, id: &str) -> Option<String> {
        let map = self.sessions.lock().unwrap();
        let sess = map.get(id)?.clone();
        drop(map);
        let h = sess.history.lock().unwrap();
        Some(String::from_utf8_lossy(&h).into_owned())
    }

    pub fn list(&self) -> Vec<TerminalDto> {
        let map = self.sessions.lock().unwrap();
        map.iter()
            .map(|(id, s)| TerminalDto {
                id: id.clone(),
                cwd: s.cwd.clone(),
                cols: *s.cols.lock().unwrap(),
                rows: *s.rows.lock().unwrap(),
            })
            .collect()
    }
}

// ---- HTTP handlers ------------------------------------------------------

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateTerminalBody>,
) -> Result<Json<TerminalDto>, (StatusCode, String)> {
    let cols = body.cols.unwrap_or(80);
    let rows = body.rows.unwrap_or(24);
    state
        .terminals
        .spawn(body.cwd.as_deref(), cols, rows)
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
