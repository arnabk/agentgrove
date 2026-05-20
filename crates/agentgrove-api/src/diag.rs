//! Diagnostic endpoints — process / memory introspection scoped to
//! AgentGrove and its own child processes (PTYs).
//!
//! `GET /api/diag/memory` returns the backend's RSS + virtual memory and
//! the per-PTY child memory for every live terminal session. The FE
//! renders this as a small live indicator in the top-right corner.

use crate::state::AppState;
use axum::{extract::State, Json};
use serde::Serialize;
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
