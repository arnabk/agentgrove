//! Built-in theme registry + JSON import endpoint.

use crate::state::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub kind: String, // "light" | "dark"
    pub colors: ThemeColors,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeColors {
    pub bg: String,
    pub fg: String,
    pub muted: String,
    pub accent: String,
}

fn builtin() -> Vec<Theme> {
    vec![
        Theme {
            id: "dark-default".into(),
            name: "AgentGrove Dark".into(),
            kind: "dark".into(),
            colors: ThemeColors {
                bg: "#0e1014".into(),
                fg: "#e8ecf2".into(),
                muted: "#98a2b3".into(),
                accent: "#7c5cff".into(),
            },
        },
        Theme {
            id: "light-default".into(),
            name: "AgentGrove Light".into(),
            kind: "light".into(),
            colors: ThemeColors {
                bg: "#fafafa".into(),
                fg: "#0e1014".into(),
                muted: "#4b5563".into(),
                accent: "#5b3df5".into(),
            },
        },
        Theme {
            id: "solarized-dark".into(),
            name: "Solarized Dark".into(),
            kind: "dark".into(),
            colors: ThemeColors {
                bg: "#002b36".into(),
                fg: "#93a1a1".into(),
                muted: "#586e75".into(),
                accent: "#268bd2".into(),
            },
        },
        Theme {
            id: "tokyo-night".into(),
            name: "Tokyo Night".into(),
            kind: "dark".into(),
            colors: ThemeColors {
                bg: "#1a1b26".into(),
                fg: "#c0caf5".into(),
                muted: "#565f89".into(),
                accent: "#7aa2f7".into(),
            },
        },
    ]
}

pub async fn list(State(_s): State<AppState>) -> Json<Vec<Theme>> {
    Json(builtin())
}

pub async fn import_theme(
    State(_s): State<AppState>,
    Json(t): Json<Theme>,
) -> Result<Json<Theme>, (StatusCode, String)> {
    if t.id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "id is empty".into()));
    }
    Ok(Json(t))
}
