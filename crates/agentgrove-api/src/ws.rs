//! Multiplexed WebSocket hub.
//!
//! Clients connect to `/ws?topic=<key>&token=<bearer>` and receive each
//! published message on that topic as a text frame. Auth is via the
//! `token` query string parameter (since browsers can't set headers on
//! WS connections without subprotocols).

use crate::state::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub topic: String,
    pub token: String,
}

pub async fn handler(
    State(state): State<AppState>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if q.token != *state.token {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let topic = q.topic.clone();
    let state2 = state.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, state2, topic))
}

async fn handle_socket(mut socket: WebSocket, state: AppState, topic: String) {
    let mut rx = state.logbus.subscribe(&topic);
    // Send a small hello frame so clients know they're subscribed.
    let _ = socket
        .send(Message::Text(format!("{{\"subscribed\":\"{topic}\"}}")))
        .await;
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(text) => {
                        if socket.send(Message::Text(text)).await.is_err() { break; }
                    }
                    Err(_) => continue,
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}
