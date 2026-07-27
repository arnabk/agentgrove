//! Built-in theme registry + JSON import endpoint.

use crate::state::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub kind: String, // "light" | "dark"
    pub custom: bool,
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
            custom: false,
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
            custom: false,
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
            custom: false,
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
            custom: false,
            colors: ThemeColors {
                bg: "#1a1b26".into(),
                fg: "#c0caf5".into(),
                muted: "#565f89".into(),
                accent: "#7aa2f7".into(),
            },
        },
        Theme {
            id: "material-dark".into(),
            name: "Material Dark".into(),
            kind: "dark".into(),
            custom: false,
            colors: ThemeColors {
                bg: "#0e0f15".into(),
                fg: "#e9e9f1".into(),
                muted: "#a6a8ba".into(),
                accent: "#9d95ff".into(),
            },
        },
    ]
}

pub async fn list(State(state): State<AppState>) -> Json<Vec<Theme>> {
    let mut themes = builtin();
    let settings = crate::settings::load(&state.state_dir).await;
    for mut t in settings.custom_themes {
        t.custom = true;
        themes.push(t);
    }
    Json(themes)
}

pub async fn import_theme(
    State(state): State<AppState>,
    Json(mut t): Json<Theme>,
) -> Result<Json<Theme>, (StatusCode, String)> {
    if t.id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "id is empty".into()));
    }
    if !matches!(t.kind.as_str(), "light" | "dark") {
        return Err((StatusCode::BAD_REQUEST, "kind must be light or dark".into()));
    }
    t.custom = true;
    let mut settings = crate::settings::load(&state.state_dir).await;
    settings.custom_themes.retain(|x| x.id != t.id);
    settings.custom_themes.push(t.clone());
    crate::settings::write_settings(&state.state_dir, &settings)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(t))
}

pub async fn delete_theme(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let mut settings = crate::settings::load(&state.state_dir).await;
    let before = settings.custom_themes.len();
    settings.custom_themes.retain(|x| x.id != id);
    if settings.custom_themes.len() == before {
        return Err((StatusCode::NOT_FOUND, "theme not found".into()));
    }
    crate::settings::write_settings(&state.state_dir, &settings)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}
