//! In-memory chat aggregate (M4 scope). Stored in `AppState`.
//!
//! Each chat lives under a worktree and tracks a list of prompts. Prompts
//! capture the user's input plus the events streamed by the agent
//! provider. For M0+M1 we don't persist these to SQLite; that lands when
//! we ship the AI-revert flow.

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
    pub worktree_id: String,
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
    by_worktree: HashMap<String, Vec<String>>,
}

impl ChatRegistry {
    pub fn create(
        &mut self,
        worktree_id: String,
        title: String,
        provider: String,
        model: String,
    ) -> ChatRecord {
        let rec = ChatRecord {
            id: Uuid::now_v7().to_string(),
            worktree_id: worktree_id.clone(),
            title,
            provider,
            model,
            created_at: Utc::now(),
            prompts: vec![],
        };
        self.by_worktree
            .entry(worktree_id)
            .or_default()
            .push(rec.id.clone());
        self.by_id.insert(rec.id.clone(), rec.clone());
        rec
    }

    pub fn list_for_worktree(&self, wt: &str) -> Vec<ChatRecord> {
        self.by_worktree
            .get(wt)
            .map(|ids| {
                ids.iter()
                    .filter_map(|i| self.by_id.get(i).cloned())
                    .collect()
            })
            .unwrap_or_default()
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
}

#[derive(Debug, Deserialize)]
pub struct AddPromptBody {
    pub content: String,
}

pub async fn list(State(state): State<AppState>, Path(wt): Path<String>) -> Json<Vec<ChatRecord>> {
    let reg = state.chats.read().await;
    Json(reg.list_for_worktree(&wt))
}

pub async fn create(
    State(state): State<AppState>,
    Path(wt): Path<String>,
    Json(body): Json<CreateChatBody>,
) -> Json<ChatRecord> {
    let mut reg = state.chats.write().await;
    Json(reg.create(wt, body.title, body.provider, body.model))
}

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
    // For M4: dispatch FakeProvider which echoes the prompt as tokens.
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
