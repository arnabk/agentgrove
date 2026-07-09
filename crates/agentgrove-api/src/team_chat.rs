use crate::state::AppState;
use agentgrove_store::TeamChatMessage;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct SendMessageReq {
    pub sender: String,
    pub body: String,
}

pub async fn whoami() -> Json<serde_json::Value> {
    let name = whoami::username();
    Json(serde_json::json!({ "username": name }))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<TeamChatMessage>>, StatusCode> {
    let msgs = TeamChatMessage::list(&state.db).await.map_err(|e| {
        tracing::error!("failed to list team chat messages: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(Json(msgs))
}

pub async fn send(
    State(state): State<AppState>,
    Json(req): Json<SendMessageReq>,
) -> Result<Json<TeamChatMessage>, StatusCode> {
    let id = uuid::Uuid::now_v7().to_string();
    let msg = TeamChatMessage::insert(&state.db, &id, &req.sender, &req.body)
        .await
        .map_err(|e| {
            tracing::error!("failed to insert team chat message: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    #[derive(Serialize)]
    #[serde(tag = "type")]
    #[serde(rename_all = "snake_case")]
    enum TeamChatEvent {
        Message {
            id: String,
            sender: String,
            body: String,
            created_at: String,
        },
    }

    state.logbus.publish(
        "team-chat",
        serde_json::to_string(&TeamChatEvent::Message {
            id: msg.id.clone(),
            sender: msg.sender.clone(),
            body: msg.body.clone(),
            created_at: msg.created_at.to_rfc3339(),
        })
        .unwrap(),
    );

    Ok(Json(msg))
}
