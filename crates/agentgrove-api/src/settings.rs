//! User settings persisted as a single JSON file under the state dir.

use crate::state::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

/// A reusable prompt template. Users define these once and pick from
/// them in the chat input. Bodies can contain any text; the FE simply
/// inserts the body verbatim at the cursor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTemplate {
    /// Stable id (uuid). Kept on update so existing references in
    /// the FE survive renames.
    pub id: String,
    /// Short human label shown in the picker.
    pub name: String,
    /// Body text inserted into the chat input on selection.
    pub body: String,
}

/// User-tunable preferences. All fields optional in the JSON form so we
/// can extend without breaking existing files.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Theme id (matches `Theme.id` from `/api/themes`).
    #[serde(default)]
    pub theme: Option<String>,
    /// CSS font-family stack used for UI text.
    #[serde(default)]
    pub ui_font: Option<String>,
    /// CSS font-family stack for code (editor, terminal, mono cells).
    #[serde(default)]
    pub mono_font: Option<String>,
    /// Base UI font size in px.
    #[serde(default)]
    pub font_size: Option<u32>,
    /// User-defined reusable prompt templates. Order is preserved so
    /// the FE picker shows them as the user arranged them.
    #[serde(default)]
    pub prompts: Vec<PromptTemplate>,
    /// Legacy sticky flag: was set the very first time we seeded any
    /// default prompts. Kept on the struct so older files still
    /// deserialise; superseded by `applied_prompt_seeds` (below)
    /// which tracks individual seed batches by id so we can ship new
    /// default templates over time without re-injecting old ones.
    #[serde(default)]
    pub prompts_seeded: bool,
    /// Ids of seed batches that have already been merged into the
    /// user's `prompts` list. Each batch is identified by a short
    /// version string (e.g. `"v1"`); future batches use new ids
    /// (`"v2"`, …) so we can extend the seed set without re-adding
    /// templates the user has deliberately deleted.
    ///
    /// Idempotent + append-only — once a batch id lands here we
    /// never re-run that seed pass even if every template from it is
    /// gone from `prompts`.
    #[serde(default)]
    pub applied_prompt_seeds: Vec<String>,
}

/// Seed list of reusable prompt templates that ship out of the box.
///
/// These are written into the user's settings on first load (or for
/// legacy settings files that pre-date the `prompts_seeded` flag) and
/// then left alone forever — edits + deletions stick because we set
/// `prompts_seeded = true` after the first injection. The intent is
/// "useful starting set", not "canonical templates": users are
/// expected to edit them. Ids are deterministic UUIDs so two installs
/// pointing at the same settings file converge.
fn default_prompts() -> Vec<PromptTemplate> {
    // The bodies are written in the imperative voice the agent CLIs
    // (Claude / Codex / etc.) parse well: short context line + a
    // bulleted list of expectations. Keep them under ~12 lines so they
    // fit comfortably in the slash-menu preview.
    vec![
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000001".into(),
            name: "Create PR".into(),
            body: "Open a pull request for the current branch.\n\
\n\
Please:\n\
- Inspect `git status`, `git diff`, and the latest commits to understand the change.\n\
- Push the current branch to its tracking remote (create one with `-u` if missing).\n\
- Create the PR against the repo's default branch using `gh pr create`.\n\
- Title: short, imperative, no trailing period. Match the repo's style.\n\
- Body: short summary, bullet list of changes, and a `Test plan` section listing the commands you ran (lint, typecheck, tests).\n\
- Reply with only the PR URL when done."
                .into(),
        },
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000002".into(),
            name: "Code review".into(),
            body: "Review the changes on this branch as if you were a senior engineer on the team.\n\
\n\
Please cover, in order:\n\
- Correctness — does each change do what the commit message claims?\n\
- Edge cases — null/empty/error paths, race conditions, off-by-ones.\n\
- Tests — coverage gaps, brittle assertions, missing failure-mode tests.\n\
- Readability — naming, dead code, oversized functions, leaked abstractions.\n\
- Performance — obvious N+1s, unnecessary allocations, blocking I/O on hot paths.\n\
- Security — input validation, secret handling, auth boundaries.\n\
\n\
Format: grouped headings above, with file:line citations for every finding."
                .into(),
        },
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000003".into(),
            name: "Explain this code".into(),
            body: "Explain the highlighted code (or the file currently open in the editor) the way you'd explain it to a teammate new to this codebase.\n\
\n\
Please:\n\
- Start with one sentence on what the code is for.\n\
- Walk through the data flow — what comes in, what goes out, what side effects occur.\n\
- Call out any non-obvious invariants or assumptions.\n\
- Flag the trickiest 1-2 lines and explain *why* they exist (not just what they do)."
                .into(),
        },
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000004".into(),
            name: "Write tests".into(),
            body: "Write tests for the change on this branch (or the file/function I have open).\n\
\n\
Please:\n\
- First locate the existing test setup in this repo (framework, helpers, fixtures) and follow it. Do NOT introduce a new framework.\n\
- Cover the happy path plus at least two edge cases (empty input, error path, boundary).\n\
- Prefer pure unit tests where possible; only reach for integration/e2e style when behaviour spans multiple modules.\n\
- After writing, run the test command and paste the output."
                .into(),
        },
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000005".into(),
            name: "Refactor for clarity".into(),
            body: "Refactor the file (or selection) for clarity without changing behaviour.\n\
\n\
Constraints:\n\
- Behaviour MUST be preserved — every existing test must still pass.\n\
- Prefer small, named functions over inline blocks.\n\
- Reduce nesting; prefer early returns.\n\
- Tighten naming — variables that lie should be renamed.\n\
- No drive-by formatting changes outside the area being refactored.\n\
- After the refactor, run lint + typecheck + tests and report the result."
                .into(),
        },
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000006".into(),
            name: "Debug failing test".into(),
            body: "A test is failing. Help me find the root cause.\n\
\n\
Please:\n\
- Re-run the failing test in isolation and capture the actual vs expected output.\n\
- Bisect the change — narrow which commit/file introduced the regression.\n\
- Read the implementation under test and the test setup; look for shared mutable state, ordering assumptions, and timing bugs first.\n\
- Propose the minimum diff that makes the test pass without weakening its assertions.\n\
- If the test is wrong (not the code), say so and justify it."
                .into(),
        },
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000007".into(),
            name: "Generate commit message".into(),
            body: "Generate a commit message for the currently-staged changes.\n\
\n\
Format:\n\
- Subject: ≤ 72 chars, imperative mood, no trailing period.\n\
- Body (only if the change isn't self-explanatory): wrap at 72 cols, explain *why* not *what*.\n\
- Match the repo's existing commit style (check `git log --oneline -10`).\n\
- Do NOT mention tools or AI in the message.\n\
\n\
Reply with only the commit message — no preamble."
                .into(),
        },
        PromptTemplate {
            id: "00000000-0000-4000-8000-000000000008".into(),
            name: "Summarise recent changes".into(),
            body: "Summarise what's changed on this branch relative to its base.\n\
\n\
Please:\n\
- Run `git log --oneline <base>..HEAD` and `git diff --stat <base>..HEAD`.\n\
- Group changes by area (e.g. \"API\", \"UI\", \"tests\", \"docs\").\n\
- For each group give a one-line summary + the affected files.\n\
- Flag anything user-visible (new endpoints, schema changes, breaking renames) at the top.\n\
- Keep the whole summary under ~25 lines."
                .into(),
        },
    ]
}

fn settings_path(state_dir: &std::path::Path) -> PathBuf {
    state_dir.join("settings.json")
}

/// Stable id for the first batch of default prompt templates we
/// ship. Bump (`"v2"`, ...) and add a new constant + matching batch
/// in `seed_batches()` when shipping additional templates later.
const PROMPT_SEED_V1: &str = "v1";

/// Every seed batch we know how to apply, in deterministic order.
/// Each entry returns the templates for that batch — the read path
/// merges them into the user's `prompts` list iff the batch id is
/// not already in `applied_prompt_seeds`.
fn seed_batches() -> Vec<(&'static str, Vec<PromptTemplate>)> {
    vec![(PROMPT_SEED_V1, default_prompts())]
}

async fn read_settings(state_dir: &std::path::Path) -> Settings {
    let p = settings_path(state_dir);
    let mut s: Settings = match fs::read(&p).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    };

    // Legacy bridge: pre-migration files have `prompts_seeded = true`
    // because the original seeding code set that flag even when the
    // user already had at least one prompt (so we never injected the
    // defaults). Treat those files as if NO seed batches have run,
    // letting the v1 batch run for them now. The flag itself stays
    // serialised so older builds reading the file later won't double-
    // seed; new builds key entirely off `applied_prompt_seeds`.
    let mut dirty = false;

    // Walk every known batch in order. Append-only: each batch ID
    // sticks in `applied_prompt_seeds` once applied (or skipped).
    for (batch_id, templates) in seed_batches() {
        if s.applied_prompt_seeds.iter().any(|x| x == batch_id) {
            continue;
        }
        // Merge: add only the templates whose id isn't already in the
        // user's list (so re-applying after a partial delete won't
        // resurrect everything — only fills gaps). Preserves the
        // user's ordering by appending new templates at the end.
        for tpl in templates {
            if !s.prompts.iter().any(|existing| existing.id == tpl.id) {
                s.prompts.push(tpl);
            }
        }
        s.applied_prompt_seeds.push(batch_id.to_string());
        // Keep the legacy flag in sync so a future downgrade to the
        // old code doesn't re-seed v1 a second time.
        s.prompts_seeded = true;
        dirty = true;
    }

    if dirty {
        // Best-effort persistence. A write failure here is non-fatal:
        // the next read will retry, and the next successful PUT will
        // persist the migration markers for good.
        let _ = write_settings(state_dir, &s).await;
    }
    s
}

async fn write_settings(state_dir: &std::path::Path, s: &Settings) -> std::io::Result<()> {
    let p = settings_path(state_dir);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_vec_pretty(s).unwrap_or_else(|_| b"{}".to_vec());
    fs::write(p, json).await
}

pub async fn get(State(state): State<AppState>) -> Json<Settings> {
    Json(read_settings(&state.state_dir).await)
}

pub async fn put(
    State(state): State<AppState>,
    Json(body): Json<Settings>,
) -> Result<Json<Settings>, (StatusCode, String)> {
    write_settings(&state.state_dir, &body)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(body))
}
