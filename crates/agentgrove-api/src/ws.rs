//! Multiplexed WebSocket hub.
//!
//! Clients connect to `/ws?topic=<key>` and receive each published message
//! on that topic as a text frame. The server binds to loopback by default;
//! there is no auth.

use crate::state::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub topic: String,
}

pub async fn handler(
    State(state): State<AppState>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let topic = q.topic.clone();
    let state2 = state.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, state2, topic))
}

async fn handle_socket(mut socket: WebSocket, state: AppState, topic: String) {
    let (mut rx, history) = state.logbus.subscribe(&topic);
    let _ = socket
        .send(Message::Text(format!("{{\"subscribed\":\"{topic}\"}}")))
        .await;
    // Replay any buffered history so a late subscriber catches up.
    for entry in history {
        if socket.send(Message::Text(entry)).await.is_err() {
            return;
        }
    }
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
