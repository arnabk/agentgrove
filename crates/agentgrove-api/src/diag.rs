//! Diagnostic endpoints — process / memory introspection scoped to
//! AgentGrove and its own child processes (PTYs).
//!
//! `GET /api/diag/memory` returns the backend's RSS + virtual memory and
//! the per-PTY child memory for every live terminal session. The FE
//! renders this as a small live indicator in the top-right corner.

use crate::state::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::io::Write;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Debug, Serialize)]
pub struct MemoryReport {
    /// AgentGrove backend process (this binary).
    pub backend: ProcessMemory,
    /// Live PTY children spawned by the terminal manager.
    pub children: Vec<ProcessMemory>,
    /// Sum of backend + children, in bytes — for the headline pill.
    pub total_rss_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ProcessMemory {
    /// Logical id the FE labels rows with: `"backend"` or `"terminal:<id>"`.
    pub kind: String,
    /// OS PID.
    pub pid: u32,
    /// Human label (executable name, "agentgrove", etc.).
    pub name: String,
    /// Resident set size in bytes.
    pub rss_bytes: u64,
    /// Virtual memory size in bytes.
    pub virt_bytes: u64,
}

pub async fn memory(State(state): State<AppState>) -> Json<MemoryReport> {
    let self_pid = std::process::id();
    let mut wanted: Vec<(String, u32)> = vec![("backend".to_string(), self_pid)];
    for (tid, pid) in state.terminals.child_pids() {
        wanted.push((format!("terminal:{tid}"), pid));
    }

    let pids: Vec<Pid> = wanted.iter().map(|(_, p)| Pid::from_u32(*p)).collect();

    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::everything(),
    );

    let mut backend = ProcessMemory {
        kind: "backend".into(),
        pid: self_pid,
        name: "agentgrove".into(),
        rss_bytes: 0,
        virt_bytes: 0,
    };
    let mut children: Vec<ProcessMemory> = Vec::new();
    let mut total: u64 = 0;

    for (kind, pid) in wanted {
        let p = match sys.process(Pid::from_u32(pid)) {
            Some(p) => p,
            None => continue,
        };
        let rss = p.memory();
        let virt = p.virtual_memory();
        total = total.saturating_add(rss);
        let entry = ProcessMemory {
            kind: kind.clone(),
            pid,
            name: p.name().to_string_lossy().into_owned(),
            rss_bytes: rss,
            virt_bytes: virt,
        };
        if kind == "backend" {
            backend = entry;
        } else {
            children.push(entry);
        }
    }

    Json(MemoryReport {
        backend,
        children,
        total_rss_bytes: total,
    })
}

/// One client-side log line forwarded from the FE. Every toast the UI
/// shows is sent here so transient error messages (which otherwise
/// vanish after ~8s and live only in the browser) are persisted to
/// `<state_dir>/logs/client.log` and the server tracing stream. This
/// is what makes a user-reported "I got an error toast" debuggable
/// after the fact without having to reproduce it live.
#[derive(Debug, Deserialize)]
pub struct ClientLogEntry {
    /// "error" | "warn" | "info". Defaults to "info" if omitted.
    #[serde(default)]
    pub level: Option<String>,
    /// Short headline (toast title).
    pub title: String,
    /// Body / detail (toast message).
    #[serde(default)]
    pub message: Option<String>,
    /// Optional structured context (route, ids, etc.) the FE wants to
    /// attach. Serialized verbatim into the log line.
    #[serde(default)]
    pub context: Option<serde_json::Value>,
}

/// `POST /api/diag/client-log` — persist a single FE log/toast line.
///
/// Best-effort: a logging failure must never break the UI, so we
/// always return 204 even if the file append errors (the tracing
/// event still fires). Appends are line-buffered JSON so the file is
/// greppable.
pub async fn client_log(
    State(state): State<AppState>,
    Json(entry): Json<ClientLogEntry>,
) -> StatusCode {
    let level = entry.level.as_deref().unwrap_or("info");
    let msg = entry.message.clone().unwrap_or_default();

    // Mirror to the server tracing stream at a matching level so it
    // shows up in dev-backend.log alongside backend events.
    match level {
        "error" => {
            tracing::error!(target: "client", title = %entry.title, message = %msg, "client toast")
        }
        "warn" => {
            tracing::warn!(target: "client", title = %entry.title, message = %msg, "client toast")
        }
        _ => tracing::info!(target: "client", title = %entry.title, message = %msg, "client toast"),
    }

    // Append a structured line to <state_dir>/logs/client.log.
    let line = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "level": level,
        "title": entry.title,
        "message": msg,
        "context": entry.context,
    });
    let logs_dir = state.state_dir.join("logs");
    if std::fs::create_dir_all(&logs_dir).is_ok() {
        let path = logs_dir.join("client.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "{line}");
        }
    }

    StatusCode::NO_CONTENT
}
