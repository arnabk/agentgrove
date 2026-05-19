//! `/api/projects` routes.

use crate::state::AppState;
use agentgrove_store::{NewProject, ProjectError, ProjectRecord};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct CreateProjectBody {
    pub name: String,
    pub root: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    pub root: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<ProjectRecord> for ProjectDto {
    fn from(r: ProjectRecord) -> Self {
        Self {
            id: r.id,
            name: r.name,
            root: r.root.to_string_lossy().into_owned(),
            created_at: r.created_at.to_rfc3339(),
            updated_at: r.updated_at.to_rfc3339(),
        }
    }
}

fn map_err(e: ProjectError) -> (StatusCode, String) {
    use ProjectError::*;
    match e {
        EmptyName => (StatusCode::BAD_REQUEST, "name is empty".into()),
        RelativeRoot(p) => (
            StatusCode::BAD_REQUEST,
            format!("root must be absolute: {}", p.display()),
        ),
        DuplicateRoot(p) => (
            StatusCode::CONFLICT,
            format!("project at {} already exists", p.display()),
        ),
        NotFound(id) => (StatusCode::NOT_FOUND, format!("project {id} not found")),
        Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    }
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateProjectBody>,
) -> Result<Json<ProjectDto>, (StatusCode, String)> {
    let root = std::path::PathBuf::from(&body.root);
    if !root.exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("path does not exist: {}", root.display()),
        ));
    }
    let rec = state
        .projects
        .create(NewProject {
            name: body.name,
            root,
        })
        .await
        .map_err(map_err)?;
    Ok(Json(rec.into()))
}

pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProjectDto>>, (StatusCode, String)> {
    let all = state.projects.list().await.map_err(map_err)?;
    Ok(Json(all.into_iter().map(Into::into).collect()))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProjectDto>, (StatusCode, String)> {
    let rec = state.projects.get(&id).await.map_err(map_err)?;
    Ok(Json(rec.into()))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let removed = state.projects.delete(&id).await.map_err(map_err)?;
    if !removed {
        return Err((StatusCode::NOT_FOUND, format!("project {id} not found")));
    }
    Ok(StatusCode::NO_CONTENT)
}
