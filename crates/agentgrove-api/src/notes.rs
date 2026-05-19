//! Notes per chat. In-memory for M0-M6 scope.

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

#[derive(Debug, Clone, Serialize)]
pub struct NoteRecord {
    pub id: String,
    pub chat_id: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Default, Debug)]
pub struct NoteRegistry {
    by_chat: HashMap<String, Vec<NoteRecord>>,
}

impl NoteRegistry {
    pub fn add(&mut self, chat_id: String, body: String) -> NoteRecord {
        let rec = NoteRecord {
            id: Uuid::now_v7().to_string(),
            chat_id: chat_id.clone(),
            body,
            created_at: Utc::now(),
        };
        self.by_chat.entry(chat_id).or_default().push(rec.clone());
        rec
    }

    pub fn list(&self, chat_id: &str) -> Vec<NoteRecord> {
        self.by_chat.get(chat_id).cloned().unwrap_or_default()
    }

    pub fn remove(&mut self, chat_id: &str, note_id: &str) -> bool {
        let Some(v) = self.by_chat.get_mut(chat_id) else {
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
