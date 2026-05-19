//! `/whoami` is protected. Verifies the auth middleware happy + error paths.

use crate::support::BeHarness;

#[tokio::test]
async fn whoami_requires_auth_header() {
    let h = BeHarness::start().await;
    let res = h.get_anon("/whoami").send().await.unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn whoami_rejects_bad_token() {
    let h = BeHarness::start().await;
    let res = h
        .client
        .get(format!("{}/whoami", h.base_url))
        .bearer_auth("nope")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn whoami_accepts_correct_token() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/whoami").send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "authenticated");
}

#[tokio::test]
async fn whoami_open_when_auth_disabled() {
    let h = BeHarness::start_no_auth().await;
    // No Authorization header.
    let res = h.get_anon("/whoami").send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "authenticated");
}

#[tokio::test]
async fn projects_open_when_auth_disabled() {
    let h = BeHarness::start_no_auth().await;
    let res = h.get_anon("/api/projects").send().await.unwrap();
    assert_eq!(res.status(), 200);
}
