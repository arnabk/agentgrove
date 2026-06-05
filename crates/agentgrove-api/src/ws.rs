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
    // Track how many history entries we've already sent so a Lagged
    // recovery can replay only the NEW tail, not the whole buffer again.
    let mut sent_history = history.len();
    let _ = socket
        .send(Message::Text(format!("{{\"subscribed\":\"{topic}\"}}")))
        .await;
    // Replay any buffered history so a late subscriber catches up.
    for entry in history {
        if socket.send(Message::Text(entry)).await.is_err() {
            return;
        }
    }

    // Heartbeat: a long agent turn (multi-minute investigations with no
    // output until the very end) leaves the socket idle, and idle
    // WebSockets get dropped by the OS / browser / any proxy after ~60s.
    // When that happens the agent's final burst of tokens never reaches
    // the client and the chat looks dead until a manual reload. A
    // periodic Ping keeps the connection alive across the silence.
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(text) => {
                        if socket.send(Message::Text(text)).await.is_err() { break; }
                        sent_history += 1;
                    }
                    // The broadcast channel dropped messages because this
                    // consumer fell behind (e.g. a big end-of-turn burst).
                    // Re-sync from the topic's replay history so we don't
                    // silently lose the tail — this is what caused
                    // "blank, then everything appears at once / never".
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let (new_rx, hist) = state.logbus.subscribe(&topic);
                        rx = new_rx;
                        // Send only entries we haven't already delivered.
                        let tail = hist.iter().skip(sent_history.min(hist.len()));
                        for entry in tail {
                            if socket.send(Message::Text(entry.clone())).await.is_err() {
                                return;
                            }
                        }
                        sent_history = hist.len();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    // Browsers auto-reply to our Ping with a Pong; we
                    // just consume it. Any other frame is ignored.
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new())).await.is_err() { break; }
            }
        }
    }
}
