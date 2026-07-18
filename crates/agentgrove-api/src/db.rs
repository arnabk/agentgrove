//! Simple SQL editor / table browser backed by PostgreSQL.
//!
//! Connects to a single Postgres database via tokio-postgres. The default
//! connection string is `postgres://postgres:postgres@localhost:5432/postgres`,
//! matching the local dev Postgres the user asked for. All endpoints accept an
//! optional `connection` query/body parameter so the UI can override it later.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::{Client, NoTls};

use crate::state::AppState;

fn default_connection() -> String {
    std::env::var("AG_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/evo-db".to_string())
}

const fn default_limit() -> i64 {
    50
}

const fn default_offset() -> i64 {
    0
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("postgres connection failed: {0}")]
    Connection(#[from] tokio_postgres::Error),
    #[error("invalid identifier: {0}")]
    InvalidIdentifier(String),
    #[error("bad request: {0}")]
    BadRequest(String),
}

impl IntoResponse for DbError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            DbError::InvalidIdentifier(_) | DbError::BadRequest(_) => StatusCode::BAD_REQUEST,
            DbError::Connection(_) => StatusCode::BAD_GATEWAY,
        };
        let body = Json(serde_json::json!({ "error": self.to_string() }));
        (status, body).into_response()
    }
}

async fn connect(connection: &str) -> Result<Client, DbError> {
    let (client, conn) = tokio_postgres::connect(connection, NoTls).await?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::error!("postgres connection error: {}", e);
        }
    });
    Ok(client)
}

// ------------------------------------------------------------------
// /api/db/info
// ------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct InfoResponse {
    /// The server-side fallback connection string (env `AG_DATABASE_URL`
    /// or the compiled-in dev default). The FE uses it to seed the
    /// connection manager on first run.
    default_connection: String,
}

pub async fn info(State(_state): State<AppState>) -> Json<InfoResponse> {
    Json(InfoResponse {
        default_connection: default_connection(),
    })
}

// ------------------------------------------------------------------
// /api/db/test
// ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TestBody {
    #[serde(default)]
    connection: String,
}

#[derive(Debug, Serialize)]
pub struct TestResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Probe a connection string without touching any saved state. Always
/// 200 — the FE renders `error` inline in the add/edit form, so a bad
/// connection is not an HTTP error.
pub async fn test(
    State(_state): State<AppState>,
    Json(body): Json<TestBody>,
) -> Json<TestResponse> {
    let connection = if body.connection.trim().is_empty() {
        default_connection()
    } else {
        body.connection
    };
    let result = async {
        let client = connect(&connection).await?;
        let row = client.query_one("SELECT version()", &[]).await?;
        Ok::<String, DbError>(row.get(0))
    }
    .await;
    match result {
        Ok(version) => Json(TestResponse {
            ok: true,
            server_version: Some(version),
            error: None,
        }),
        Err(e) => Json(TestResponse {
            ok: false,
            server_version: None,
            error: Some(e.to_string()),
        }),
    }
}

// ------------------------------------------------------------------
// /api/db/tables
// ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TablesParams {
    #[serde(default = "default_connection")]
    connection: String,
}

#[derive(Debug, Serialize)]
pub struct TablesResponse {
    tables: Vec<String>,
}

pub async fn tables(
    State(_state): State<AppState>,
    Query(params): Query<TablesParams>,
) -> Result<Json<TablesResponse>, DbError> {
    let client = connect(&params.connection).await?;
    let rows = client
        .query(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = 'public' ORDER BY table_name",
            &[],
        )
        .await?;
    let tables = rows.iter().map(|r| r.get::<_, String>(0)).collect();
    Ok(Json(TablesResponse { tables }))
}

// ------------------------------------------------------------------
// /api/db/tables/:table/columns
// ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ColumnsParams {
    #[serde(default = "default_connection")]
    connection: String,
}

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    name: String,
    data_type: String,
}

#[derive(Debug, Serialize)]
pub struct ColumnsResponse {
    columns: Vec<ColumnInfo>,
}

pub async fn columns(
    State(_state): State<AppState>,
    Path(table): Path<String>,
    Query(params): Query<ColumnsParams>,
) -> Result<Json<ColumnsResponse>, DbError> {
    let (schema, name) = split_table(&table)?;
    let client = connect(&params.connection).await?;
    let rows = client
        .query(
            "SELECT column_name, data_type \
             FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2 \
             ORDER BY ordinal_position",
            &[&schema, &name],
        )
        .await?;
    let columns = rows
        .iter()
        .map(|r| ColumnInfo {
            name: r.get(0),
            data_type: r.get(1),
        })
        .collect();
    Ok(Json(ColumnsResponse { columns }))
}

// ------------------------------------------------------------------
// /api/db/tables/:table/rows
// ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RowsParams {
    #[serde(default = "default_connection")]
    connection: String,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default = "default_offset")]
    offset: i64,
    filter_col: Option<String>,
    filter_op: Option<String>,
    filter_val: Option<String>,
}

pub async fn rows(
    State(_state): State<AppState>,
    Path(table): Path<String>,
    Query(params): Query<RowsParams>,
) -> Result<Json<QueryResponse>, DbError> {
    let (schema, name) = split_table(&table)?;
    let quoted = quote_qualified(schema, name);
    let client = connect(&params.connection).await?;

    let sql = build_filtered_query(&quoted, &params)?;
    let has_filter = params
        .filter_col
        .as_ref()
        .is_some_and(|s| !s.trim().is_empty());
    let rows = if has_filter {
        let val = params.filter_val.as_deref().unwrap_or("");
        client.query(&sql, &[&val]).await?
    } else {
        client.query(&sql, &[]).await?
    };

    Ok(Json(rows_to_response(rows)))
}

// ------------------------------------------------------------------
// /api/db/query
// ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct QueryBody {
    #[serde(default = "default_connection")]
    connection: String,
    sql: String,
}

#[derive(Debug, Serialize)]
pub struct QueryResponse {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    affected_rows: Option<usize>,
}

pub async fn query(
    State(_state): State<AppState>,
    Json(body): Json<QueryBody>,
) -> Result<Json<QueryResponse>, DbError> {
    let sql = body.sql.trim();
    if sql.is_empty() {
        return Err(DbError::BadRequest("SQL query is empty".into()));
    }
    let connection = if body.connection.trim().is_empty() {
        default_connection()
    } else {
        body.connection
    };
    let client = connect(&connection).await?;

    let is_read = is_read_query(sql);
    if is_read {
        let stripped = sql.trim_end_matches(';');
        let wrapped = format!(
            "SELECT to_jsonb(t) AS row FROM (\n{}\n) t LIMIT 1000",
            stripped
        );
        let rows = client.query(&wrapped, &[]).await?;
        Ok(Json(rows_to_response(rows)))
    } else {
        let affected = client.execute(sql, &[]).await?;
        Ok(Json(QueryResponse {
            columns: vec![],
            rows: vec![],
            affected_rows: Some(affected as usize),
        }))
    }
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

fn split_table(table: &str) -> Result<(&str, &str), DbError> {
    if table.is_empty() {
        return Err(DbError::InvalidIdentifier("empty table name".into()));
    }
    let parts: Vec<&str> = table.splitn(2, '.').collect();
    if parts.len() == 2 {
        validate_identifier(parts[0])?;
        validate_identifier(parts[1])?;
        Ok((parts[0], parts[1]))
    } else {
        validate_identifier(parts[0])?;
        Ok(("public", parts[0]))
    }
}

fn validate_identifier(s: &str) -> Result<(), DbError> {
    if s.is_empty() {
        return Err(DbError::InvalidIdentifier("empty identifier".into()));
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(DbError::InvalidIdentifier(format!("'{}'", s)));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
        return Err(DbError::InvalidIdentifier(format!("'{}'", s)));
    }
    Ok(())
}

fn quote_qualified(schema: &str, name: &str) -> String {
    format!("\"{}\".\"{}\"", schema, name)
}

fn normalize_op(op: &str) -> &'static str {
    match op.trim().to_lowercase().as_str() {
        "=" => "=",
        "!=" => "!=",
        "<>" => "!=",
        "<" => "<",
        ">" => ">",
        "<=" => "<=",
        ">=" => ">=",
        "like" => "LIKE",
        "ilike" => "ILIKE",
        _ => "=",
    }
}

fn build_filtered_query(quoted_table: &str, params: &RowsParams) -> Result<String, DbError> {
    if params.limit < 1 || params.limit > 1000 {
        return Err(DbError::BadRequest(
            "limit must be between 1 and 1000".into(),
        ));
    }
    if params.offset < 0 {
        return Err(DbError::BadRequest("offset must be >= 0".into()));
    }

    let has_filter = params
        .filter_col
        .as_ref()
        .is_some_and(|s| !s.trim().is_empty());
    if !has_filter {
        return Ok(format!(
            "SELECT to_jsonb(t) AS row FROM (SELECT * FROM {} LIMIT {} OFFSET {}) t",
            quoted_table, params.limit, params.offset
        ));
    }

    let col = params.filter_col.as_ref().unwrap().trim();
    validate_identifier(col)?;
    let op = normalize_op(params.filter_op.as_deref().unwrap_or("="));

    let val = params.filter_val.as_deref().unwrap_or("").trim();
    if val.eq_ignore_ascii_case("null") && op.eq_ignore_ascii_case("=") {
        Ok(format!(
            "SELECT to_jsonb(t) AS row FROM (SELECT * FROM {} WHERE \"{}\" IS NULL LIMIT {} OFFSET {}) t",
            quoted_table, col, params.limit, params.offset
        ))
    } else if val.eq_ignore_ascii_case("not null") && op.eq_ignore_ascii_case("=") {
        Ok(format!(
            "SELECT to_jsonb(t) AS row FROM (SELECT * FROM {} WHERE \"{}\" IS NOT NULL LIMIT {} OFFSET {}) t",
            quoted_table, col, params.limit, params.offset
        ))
    } else {
        Ok(format!(
            "SELECT to_jsonb(t) AS row FROM (SELECT * FROM {} WHERE \"{}\" {} $1 LIMIT {} OFFSET {}) t",
            quoted_table, col, op, params.limit, params.offset
        ))
    }
}

fn rows_to_response(rows: Vec<tokio_postgres::Row>) -> QueryResponse {
    if rows.is_empty() {
        return QueryResponse {
            columns: vec![],
            rows: vec![],
            affected_rows: None,
        };
    }
    let mut out_rows: Vec<BTreeMap<String, serde_json::Value>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let PgJson(value) = row.get::<_, PgJson<serde_json::Value>>(0);
        if let serde_json::Value::Object(obj) = value {
            out_rows.push(obj.into_iter().collect::<BTreeMap<_, _>>());
        } else {
            out_rows.push(BTreeMap::new());
        }
    }
    let columns: Vec<String> = out_rows
        .first()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let rows = out_rows
        .into_iter()
        .map(|m| {
            columns
                .iter()
                .map(|c| m.get(c).cloned().unwrap_or(serde_json::Value::Null))
                .collect()
        })
        .collect();
    QueryResponse {
        columns,
        rows,
        affected_rows: None,
    }
}

fn is_read_query(sql: &str) -> bool {
    let head = sql
        .trim_start()
        .splitn(2, |c: char| c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_lowercase();
    matches!(
        head.as_str(),
        "select" | "with" | "values" | "explain" | "("
    )
}
