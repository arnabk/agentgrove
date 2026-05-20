//! Notes scoped by an arbitrary owner id (project or chat).
//!
//! Notes live with the **project** in the new model. The existing
//! chat-scoped routes remain wired so older clients (and L4 tests) keep
//! working; both share the same in-memory registry keyed by `scope_id`.

use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// A persisted note record. `scope_id` is the owning project (or chat for
/// the legacy chat-scoped endpoints). `chat_id` is preserved for backward
/// compatibility with existing tests and clients.
#[derive(Debug, Clone, Serialize)]
pub struct NoteRecord {
    pub id: String,
    pub scope_id: String,
    /// Legacy alias of `scope_id`. Same value.
    pub chat_id: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Default, Debug)]
pub struct NoteRegistry {
    by_scope: HashMap<String, Vec<NoteRecord>>,
}

impl NoteRegistry {
    pub fn add(&mut self, scope_id: String, body: String) -> NoteRecord {
        let rec = NoteRecord {
            id: Uuid::now_v7().to_string(),
            scope_id: scope_id.clone(),
            chat_id: scope_id.clone(),
            body,
            created_at: Utc::now(),
        };
        self.by_scope.entry(scope_id).or_default().push(rec.clone());
        rec
    }

    pub fn list(&self, scope_id: &str) -> Vec<NoteRecord> {
        self.by_scope.get(scope_id).cloned().unwrap_or_default()
    }

    pub fn remove(&mut self, scope_id: &str, note_id: &str) -> bool {
        let Some(v) = self.by_scope.get_mut(scope_id) else {
            return false;
        };
        let before = v.len();
        v.retain(|n| n.id != note_id);
        v.len() != before
    }
}

#[derive(Debug, Deserialize)]
pub struct AddNoteBody {
    pub body: String,
}

// ---- chat-scoped (legacy) -----------------------------------------------

pub async fn list(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Json<Vec<NoteRecord>> {
    Json(state.notes.read().await.list(&chat_id))
}

pub async fn add(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(body): Json<AddNoteBody>,
) -> Json<NoteRecord> {
    Json(state.notes.write().await.add(chat_id, body.body))
}

pub async fn delete(
    State(state): State<AppState>,
    Path((chat_id, note_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    if state.notes.write().await.remove(&chat_id, &note_id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

// ---- project-scoped (preferred) -----------------------------------------

pub async fn list_for_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<Vec<NoteRecord>> {
    Json(state.notes.read().await.list(&project_id))
}

pub async fn add_for_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<AddNoteBody>,
) -> Json<NoteRecord> {
    Json(state.notes.write().await.add(project_id, body.body))
}

pub async fn delete_for_project(
    State(state): State<AppState>,
    Path((project_id, note_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    if state.notes.write().await.remove(&project_id, &note_id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
