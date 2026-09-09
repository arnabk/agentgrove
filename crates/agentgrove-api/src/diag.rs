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

/// A periodic memory sample forwarded from the FE monitor. Kept
/// deliberately flat + numeric so it appends cheaply and greps/plots
/// easily. All fields optional so the FE can omit anything a given
/// browser can't measure (e.g. JS heap on Firefox).
#[derive(Debug, Deserialize)]
pub struct MemSample {
    /// JS heap used, MB (`performance.memory`), or null.
    #[serde(default)]
    pub heap_mb: Option<f64>,
    /// JS heap limit, MB, or null.
    #[serde(default)]
    pub heap_limit_mb: Option<f64>,
    /// Whole-tab bytes from measureUserAgentSpecificMemory(), or null.
    #[serde(default)]
    pub tab_bytes: Option<u64>,
    /// Live DOM node count.
    #[serde(default)]
    pub dom: Option<u64>,
    /// Live WebSocket count (FE-instrumented).
    #[serde(default)]
    pub ws: Option<u64>,
    /// Detached-listener / event-target estimate, when available.
    #[serde(default)]
    pub listeners: Option<u64>,
    /// AgentGrove self-attributed total bytes (memory accountant).
    #[serde(default)]
    pub ag_total_bytes: Option<u64>,
    /// Seconds the tab has been open (uptime), for trend x-axis.
    #[serde(default)]
    pub tab_uptime_s: Option<u64>,
    /// Whether the tab was visible at sample time (hidden tabs GC less).
    #[serde(default)]
    pub visible: Option<bool>,
    /// Top attributed subsystems (id + bytes), already trimmed by the FE.
    #[serde(default)]
    pub breakdown: Option<serde_json::Value>,
    /// "heartbeat" | "growth" | "load" | "unload" — why this sample fired.
    #[serde(default)]
    pub reason: Option<String>,
}

/// Cap for `mem.log` before it's rotated to `mem.log.1` (5 MB). One
/// generation of history is plenty for a multi-day trend at the FE's
/// low sample cadence, and it bounds disk so instrumentation can't
/// itself become a leak.
const MEM_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// `POST /api/diag/mem-sample` — append one memory sample to
/// `<state_dir>/logs/mem.log` (a dedicated file, separate from the
/// toast-oriented client.log, so the trend is a clean machine-readable
/// series). Best-effort + always 204: instrumentation must never break
/// or slow the UI. We also enrich the line with the backend's own RSS
/// so FE + BE memory can be correlated on one timeline without a
/// second round-trip.
pub async fn mem_sample(State(state): State<AppState>, Json(s): Json<MemSample>) -> StatusCode {
    // Backend RSS + a summary of live PTY children, so a backend-side
    // climb (terminals, leaked child processes) lands on the same
    // timeline as the FE signals. We refresh only our own pids — no
    // full process-table scan — so this stays cheap even with many
    // terminals open.
    let self_pid = std::process::id();
    let child_pids: Vec<(String, u32)> = state.terminals.child_pids();
    let mut pids: Vec<Pid> = vec![Pid::from_u32(self_pid)];
    pids.extend(child_pids.iter().map(|(_, p)| Pid::from_u32(*p)));

    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new().with_memory()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::new().with_memory(),
    );
    let be_rss = sys
        .process(Pid::from_u32(self_pid))
        .map(|p| p.memory())
        .unwrap_or(0);
    let mut children_rss: u64 = 0;
    for (_, pid) in &child_pids {
        if let Some(p) = sys.process(Pid::from_u32(*pid)) {
            children_rss = children_rss.saturating_add(p.memory());
        }
    }

    let line = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "reason": s.reason.as_deref().unwrap_or("heartbeat"),
        "be_rss_bytes": be_rss,
        "child_count": child_pids.len(),
        "children_rss_bytes": children_rss,
        "heap_mb": s.heap_mb,
        "heap_limit_mb": s.heap_limit_mb,
        "tab_bytes": s.tab_bytes,
        "dom": s.dom,
        "ws": s.ws,
        "listeners": s.listeners,
        "ag_total_bytes": s.ag_total_bytes,
        "tab_uptime_s": s.tab_uptime_s,
        "visible": s.visible,
        "breakdown": s.breakdown,
    });

    let logs_dir = state.state_dir.join("logs");
    if std::fs::create_dir_all(&logs_dir).is_ok() {
        let path = logs_dir.join("mem.log");
        // Size-based rotation: keep one previous generation so the file
        // can't grow without bound over a multi-day session.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() >= MEM_LOG_MAX_BYTES {
                let _ = std::fs::rename(&path, logs_dir.join("mem.log.1"));
            }
        }
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
