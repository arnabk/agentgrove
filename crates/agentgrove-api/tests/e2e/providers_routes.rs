//! L4 endpoint coverage for `GET /api/providers`.
//!
//! We don't assume the `claude` CLI is on the test host's PATH; the
//! provider list is always returned (every known provider gets a
//! descriptor even when its CLI is missing). When `claude` *is*
//! installed, the response should report `available: true`.

use crate::support::BeHarness;
use serde_json::Value;

#[tokio::test]
async fn providers_route_returns_claude_descriptor() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/api/providers").send().await.unwrap();
    assert_eq!(res.status(), 200, "body={}", res.text().await.unwrap());
    let body: Value = res.json().await.unwrap();
    let arr = body.as_array().expect("providers list is a JSON array");
    assert!(
        !arr.is_empty(),
        "expected at least one provider in the registry"
    );
    let claude = arr
        .iter()
        .find(|p| p["id"] == "claude")
        .expect("claude provider missing from /api/providers");
    assert_eq!(claude["label"], "Claude");
    assert_eq!(claude["default_model"], "sonnet");
    assert_eq!(claude["supports_resume"], true);
    assert!(
        claude["install_hint"]
            .as_str()
            .unwrap_or("")
            .starts_with("https://"),
        "install hint should be a URL"
    );
    // `available` depends on the host but the field must be a bool.
    assert!(claude["available"].is_boolean());
}

#[tokio::test]
async fn providers_route_reports_version_when_cli_present() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/api/providers").send().await.unwrap();
    let body: Value = res.json().await.unwrap();
    let arr = body.as_array().unwrap();
    let claude = arr.iter().find(|p| p["id"] == "claude").unwrap();
    if which::which("claude").is_ok() {
        assert_eq!(claude["available"], true);
        assert!(
            claude["path"].is_string() && !claude["path"].as_str().unwrap().is_empty(),
            "path should be set when CLI is installed"
        );
        assert!(
            claude["version"].is_string(),
            "version should be reported when CLI is installed"
        );
    } else {
        assert_eq!(claude["available"], false);
        assert!(claude["path"].is_null());
        assert!(claude["version"].is_null());
    }
}

#[tokio::test]
async fn providers_commands_returns_static_claude_set() {
    let h = BeHarness::start().await;
    let res = h
        .get_auth("/api/providers/claude/commands")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let arr: serde_json::Value = res.json().await.unwrap();
    let items = arr.as_array().unwrap();
    assert!(items.len() >= 5, "expected several built-in slash commands");
    let names: std::collections::BTreeSet<&str> =
        items.iter().filter_map(|c| c["name"].as_str()).collect();
    for required in ["clear", "compact", "review", "usage"] {
        assert!(names.contains(required), "missing command: {required}");
    }
    // Each item carries a non-empty description.
    for item in items {
        assert!(!item["description"].as_str().unwrap().is_empty());
    }
}

#[tokio::test]
async fn providers_commands_unknown_id_returns_404() {
    let h = BeHarness::start().await;
    let res = h
        .get_auth("/api/providers/nope/commands")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

// ----- per-provider config (PUT + GET + DELETE) --------------------------

/// Fresh install has no provider configs. Uses a neutral `"acme"`
/// id because today no shipping provider stores config here —
/// the endpoint still exists for future HTTP-API integrations and
/// must round-trip through `provider_secrets` regardless of which
/// id the client picks.
#[tokio::test]
async fn get_provider_config_returns_404_when_unset() {
    let h = BeHarness::start().await;
    let res = h.get("/api/providers/acme/config").send().await.unwrap();
    assert_eq!(res.status(), 404);
}

/// Round-trip: PUT writes base_url + api_key, GET returns the
/// summary with `has_api_key: true` (and never echoes the key).
#[tokio::test]
async fn put_then_get_provider_config_roundtrips_without_echoing_key() {
    let h = BeHarness::start().await;
    let res = h
        .put("/api/providers/acme/config")
        .json(&serde_json::json!({
            "base_url": "http://localhost:20128/v1",
            "api_key": "sk-test-secret",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let summary: serde_json::Value = res.json().await.unwrap();
    assert_eq!(summary["provider_id"], "acme");
    assert_eq!(summary["base_url"], "http://localhost:20128/v1");
    assert_eq!(summary["has_api_key"], true);
    // `default_model` belongs on the descriptor, not the secret row.
    assert!(summary.get("default_model").is_none());
    // The plaintext key MUST NOT appear anywhere in the response.
    let body = summary.to_string();
    assert!(!body.contains("sk-test-secret"), "key leaked: {body}");

    let got: serde_json::Value = h
        .get("/api/providers/acme/config")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["has_api_key"], true);
    let body = got.to_string();
    assert!(!body.contains("sk-test-secret"));
}

/// Passing `api_key: ""` clears the stored key (sets has_api_key=false).
#[tokio::test]
async fn put_with_empty_api_key_clears_stored_key() {
    let h = BeHarness::start().await;
    h.put("/api/providers/acme/config")
        .json(&serde_json::json!({"base_url":"http://a","api_key":"sk-1"}))
        .send()
        .await
        .unwrap();
    h.put("/api/providers/acme/config")
        .json(&serde_json::json!({"base_url":"http://a","api_key":""}))
        .send()
        .await
        .unwrap();
    let got: serde_json::Value = h
        .get("/api/providers/acme/config")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["has_api_key"], false);
}

/// Omitting `api_key` leaves the existing one intact (useful when
/// the user just wants to update base_url).
#[tokio::test]
async fn put_without_api_key_preserves_existing_key() {
    let h = BeHarness::start().await;
    h.put("/api/providers/acme/config")
        .json(&serde_json::json!({"base_url":"http://a","api_key":"sk-1"}))
        .send()
        .await
        .unwrap();
    h.put("/api/providers/acme/config")
        .json(&serde_json::json!({"base_url":"http://b"}))
        .send()
        .await
        .unwrap();
    let got: serde_json::Value = h
        .get("/api/providers/acme/config")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["base_url"], "http://b");
    assert_eq!(got["has_api_key"], true);
}

/// PUT rejects an empty base_url with 400 — we never want a row
/// that can't be talked to.
#[tokio::test]
async fn put_rejects_empty_base_url() {
    let h = BeHarness::start().await;
    let res = h
        .put("/api/providers/acme/config")
        .json(&serde_json::json!({"base_url":"   ","api_key":"sk"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

/// DELETE removes the row; subsequent GET returns 404 again.
#[tokio::test]
async fn delete_provider_config_wipes_row() {
    let h = BeHarness::start().await;
    h.put("/api/providers/acme/config")
        .json(&serde_json::json!({"base_url":"http://a","api_key":"sk"}))
        .send()
        .await
        .unwrap();
    let del = h.delete("/api/providers/acme/config").send().await.unwrap();
    assert_eq!(del.status(), 204);
    let after = h.get("/api/providers/acme/config").send().await.unwrap();
    assert_eq!(after.status(), 404);
}

/// `GET /api/providers` lists every CLI provider this build ships
/// with. Today that's Claude + opencode; no HTTP-API providers
/// are registered.
#[tokio::test]
async fn providers_list_contains_only_cli_providers() {
    let h = BeHarness::start().await;
    let list: serde_json::Value = h
        .get("/api/providers")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let arr = list.as_array().unwrap();
    let ids: Vec<&str> = arr.iter().filter_map(|p| p["id"].as_str()).collect();
    assert!(ids.contains(&"claude"), "claude missing: {arr:?}");
    assert!(ids.contains(&"opencode"), "opencode missing: {arr:?}");
    assert!(
        !ids.contains(&"9router"),
        "9router should be removed: {arr:?}"
    );
}

/// `POST /api/providers/:id/refresh` invalidates the BE's model
/// cache and returns a fresh descriptor with the same shape as
/// `GET /api/providers`. Used by the FE refresh icon in Settings →
/// Providers + the new-chat model picker. We can't verify the
/// cache actually got invalidated without spying on the
/// models_cache internals, but the public contract is: the
/// endpoint returns 200 with a well-formed descriptor for known
/// provider ids and 404 for unknown ones.
#[tokio::test]
async fn refresh_provider_returns_fresh_descriptor() {
    let h = BeHarness::start().await;
    let res = h
        .post("/api/providers/claude/refresh")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let dto: serde_json::Value = res.json().await.unwrap();
    assert_eq!(dto["id"], "claude");
    assert_eq!(dto["label"], "Claude");
    // Models list is environment-dependent (lives behind a
    // process-global cache + a live `claude --version` probe);
    // we just check the shape.
    assert!(dto["models"].is_array());
    assert!(dto["available"].is_boolean());
}

/// Unknown provider id returns 404, not 500.
#[tokio::test]
async fn refresh_provider_unknown_id_returns_404() {
    let h = BeHarness::start().await;
    let res = h
        .post("/api/providers/no-such-provider/refresh")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

/// `GET /api/providers/claude/commands?project_id=<pid>` returns
/// the built-in set PLUS any Markdown files the user (or this
/// project) authored under `<project>/.claude/commands/`. We
/// don't assert specific built-in names — that's a Claude-CLI
/// concern — but we DO assert that a project-scoped file we
/// plant under .claude/commands/ shows up.
#[tokio::test]
async fn slash_commands_include_project_scoped_files() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    // Plant a project-scoped command file BEFORE registering the
    // project (the scan happens lazily per-request).
    std::fs::create_dir_all(dir.path().join(".claude/commands")).unwrap();
    std::fs::write(
        dir.path().join(".claude/commands/ship-it.md"),
        "---\ndescription: ship it\n---\n",
    )
    .unwrap();
    let body = serde_json::json!({
        "name": "scoped",
        "root": dir.path().to_string_lossy(),
    });
    let created = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    let p: serde_json::Value = created.json().await.unwrap();
    let pid = p["id"].as_str().unwrap().to_owned();

    let res = h
        .get_auth(&format!("/api/providers/claude/commands?project_id={pid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let cmds: serde_json::Value = res.json().await.unwrap();
    let arr = cmds.as_array().unwrap();
    let has_scoped = arr.iter().any(|c| c["name"] == "ship-it");
    assert!(has_scoped, "project-scoped command missing: {arr:?}");
    let scoped = arr.iter().find(|c| c["name"] == "ship-it").unwrap();
    assert_eq!(scoped["description"], "ship it");
}

/// Unknown `project_id` softly falls back to user-level + built-in
/// commands rather than 500'ing — the FE may pass a stale id.
#[tokio::test]
async fn slash_commands_unknown_project_returns_global_set() {
    let h = BeHarness::start().await;
    let res = h
        .get_auth("/api/providers/claude/commands?project_id=does-not-exist")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}
