//! In-memory chat aggregate.
//!
//! Chats are owned by a **project**. They may optionally be scoped to a
//! specific **worktree** within that project. There is **no per-project
//! cap**; the UI lets users create chats freely and lists them as tabs.
//!
//! Persistence: in-memory for now; SQLite once the AI-revert timeline lands.

use crate::state::AppState;
use agentgrove_agents::AgentEvent;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRecord {
    pub id: String,
    pub project_id: String,
    /// `None` ⇒ chat lives under the project root scope.
    pub worktree_id: Option<String>,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: DateTime<Utc>,
    pub prompts: Vec<PromptRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRecord {
    pub id: String,
    pub seq: u32,
    pub content: String,
    pub events: Vec<AgentEvent>,
    pub touched_paths: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Default, Debug)]
pub struct ChatRegistry {
    by_id: HashMap<String, ChatRecord>,
    by_project: HashMap<String, Vec<String>>,
}

impl ChatRegistry {
    /// Insert a new chat owned by `project_id`, optionally scoped to a
    /// `worktree_id`.
    pub fn create(
        &mut self,
        project_id: String,
        worktree_id: Option<String>,
        title: String,
        provider: String,
        model: String,
    ) -> ChatRecord {
        let rec = ChatRecord {
            id: Uuid::now_v7().to_string(),
            project_id: project_id.clone(),
            worktree_id,
            title,
            provider,
            model,
            created_at: Utc::now(),
            prompts: vec![],
        };
        self.by_project
            .entry(project_id)
            .or_default()
            .push(rec.id.clone());
        self.by_id.insert(rec.id.clone(), rec.clone());
        rec
    }

    pub fn count_for_project(&self, project_id: &str) -> usize {
        self.by_project.get(project_id).map(|v| v.len()).unwrap_or(0)
    }

    /// List all chats for a project. If `worktree_id` is `Some(_)`,
    /// returns only chats scoped to that worktree (plus chats that match
    /// the supplied id). If `None`, returns all chats in the project.
    pub fn list_for_project(
        &self,
        project_id: &str,
        worktree_id: Option<&str>,
    ) -> Vec<ChatRecord> {
        let ids = match self.by_project.get(project_id) {
            Some(v) => v,
            None => return vec![],
        };
        ids.iter()
            .filter_map(|i| self.by_id.get(i).cloned())
            .filter(|c| match worktree_id {
                Some(w) => c.worktree_id.as_deref() == Some(w),
                None => true,
            })
            .collect()
    }

    /// Legacy: list every chat whose worktree_id matches.
    pub fn list_for_worktree(&self, wt: &str) -> Vec<ChatRecord> {
        self.by_id
            .values()
            .filter(|c| c.worktree_id.as_deref() == Some(wt))
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&ChatRecord> {
        self.by_id.get(id)
    }

    pub fn add_prompt(&mut self, chat_id: &str, content: String) -> Option<PromptRecord> {
        let chat = self.by_id.get_mut(chat_id)?;
        let seq = chat.prompts.len() as u32 + 1;
        let rec = PromptRecord {
            id: Uuid::now_v7().to_string(),
            seq,
            content,
            events: vec![],
            touched_paths: vec![],
            created_at: Utc::now(),
        };
        chat.prompts.push(rec.clone());
        Some(rec)
    }

    pub fn append_event(&mut self, chat_id: &str, prompt_id: &str, ev: AgentEvent) {
        if let Some(chat) = self.by_id.get_mut(chat_id) {
            if let Some(p) = chat.prompts.iter_mut().find(|p| p.id == prompt_id) {
                p.events.push(ev);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateChatBody {
    pub title: String,
    pub provider: String,
    pub model: String,
    /// Optional worktree scope. Ignored by the worktree-specific route
    /// (which derives this from the URL).
    #[serde(default)]
    pub worktree_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddPromptBody {
    pub content: String,
}

// ---- project-scoped routes ---------------------------------------------

pub async fn list_for_project_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<Vec<ChatRecord>> {
    let reg = state.chats.read().await;
    Json(reg.list_for_project(&project_id, None))
}

pub async fn create_for_project_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<CreateChatBody>,
) -> Result<Json<ChatRecord>, (StatusCode, String)> {
    // Validate project exists.
    if state.projects.get(&project_id).await.is_err() {
        return Err((StatusCode::NOT_FOUND, "project not found".into()));
    }

    // Validate optional worktree belongs to the project.
    if let Some(wid) = body.worktree_id.as_deref() {
        match state.worktrees.get(wid).await {
            Ok(w) if w.project_id == project_id => {}
            Ok(_) => return Err((StatusCode::BAD_REQUEST, "worktree not in project".into())),
            Err(_) => return Err((StatusCode::NOT_FOUND, "worktree not found".into())),
        }
    }

    let mut reg = state.chats.write().await;
    Ok(Json(reg.create(
        project_id,
        body.worktree_id,
        body.title,
        body.provider,
        body.model,
    )))
}

// ---- worktree-scoped routes (legacy, retained) -------------------------

pub async fn list(State(state): State<AppState>, Path(wt): Path<String>) -> Json<Vec<ChatRecord>> {
    let reg = state.chats.read().await;
    Json(reg.list_for_worktree(&wt))
}

pub async fn create(
    State(state): State<AppState>,
    Path(wt): Path<String>,
    Json(body): Json<CreateChatBody>,
) -> Result<Json<ChatRecord>, (StatusCode, String)> {
    // Derive the owning project. Worktrees not backed by a record (used by
    // some tests) fall back to "wt-as-project" so we don't panic.
    let project_id = match state.worktrees.get(&wt).await {
        Ok(rec) => rec.project_id,
        Err(_) => wt.clone(),
    };

    let mut reg = state.chats.write().await;
    Ok(Json(reg.create(
        project_id,
        Some(wt),
        body.title,
        body.provider,
        body.model,
    )))
}

// ---- prompt-level ------------------------------------------------------

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ChatRecord>, StatusCode> {
    let reg = state.chats.read().await;
    reg.get(&id).cloned().map(Json).ok_or(StatusCode::NOT_FOUND)
}

pub async fn add_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AddPromptBody>,
) -> Result<Json<PromptRecord>, StatusCode> {
    let mut reg = state.chats.write().await;
    let prompt = reg
        .add_prompt(&id, body.content.clone())
        .ok_or(StatusCode::NOT_FOUND)?;
    // For now: dispatch FakeProvider which echoes the prompt as tokens.
    let topic = format!("chat:{id}");
    let evs = vec![
        AgentEvent::Token {
            text: format!("echo: {}", body.content),
        },
        AgentEvent::Done,
    ];
    for ev in &evs {
        let payload = serde_json::json!({
            "prompt_id": prompt.id,
            "event": ev,
        });
        state.logbus.publish(&topic, payload.to_string());
        reg.append_event(&id, &prompt.id, ev.clone());
    }
    Ok(Json(prompt))
}

pub async fn revert_prompt(
    State(state): State<AppState>,
    Path((chat_id, prompt_id)): Path<(String, String)>,
) -> Result<Json<PromptRecord>, StatusCode> {
    let mut reg = state.chats.write().await;
    let chat = reg.get(&chat_id).ok_or(StatusCode::NOT_FOUND)?.clone();
    let target = chat
        .prompts
        .iter()
        .find(|p| p.id == prompt_id)
        .ok_or(StatusCode::NOT_FOUND)?
        .clone();
    let body = format!(
        "Revert the changes made by prompt {} (\"{}\"). Touched files: {}.",
        target.seq,
        target.content,
        if target.touched_paths.is_empty() {
            "(none recorded)".to_string()
        } else {
            target.touched_paths.join(", ")
        }
    );
    let new = reg
        .add_prompt(&chat_id, body)
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(new))
}
