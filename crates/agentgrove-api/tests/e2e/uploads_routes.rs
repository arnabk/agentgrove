//! L4 endpoint coverage for `/api/uploads`.

use crate::support::BeHarness;
use reqwest::multipart::{Form, Part};
use serde_json::Value;

#[tokio::test]
async fn upload_create_then_raw_roundtrip() {
    let h = BeHarness::start().await;
    let bytes: &[u8] = b"hello\nworld\n";
    let part = Part::bytes(bytes.to_vec())
        .file_name("hello.txt")
        .mime_str("text/plain")
        .unwrap();
    let form = Form::new().part("file", part);
    let res = h
        .post_auth("/api/uploads")
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "body={}", res.text().await.unwrap());
    let v: Value = res.json().await.unwrap();
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    let id = arr[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(arr[0]["filename"], "hello.txt");
    assert_eq!(arr[0]["content_type"], "text/plain");
    assert_eq!(arr[0]["size"], bytes.len());
    assert!(arr[0]["path"].as_str().unwrap().ends_with("/hello.txt"));

    // Raw roundtrip.
    let raw = h
        .get_auth(&format!("/api/uploads/{id}/raw"))
        .send()
        .await
        .unwrap();
    assert_eq!(raw.status(), 200);
    assert_eq!(raw.headers().get("content-type").unwrap(), "text/plain");
    let body = raw.bytes().await.unwrap();
    assert_eq!(&body[..], bytes);
}

#[tokio::test]
async fn upload_sanitises_filename_and_strips_path() {
    let h = BeHarness::start().await;
    let part = Part::bytes(b"x".to_vec())
        .file_name("../etc/pa ss wd")
        .mime_str("application/octet-stream")
        .unwrap();
    let form = Form::new().part("file", part);
    let v: Value = h
        .post_auth("/api/uploads")
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v[0]["filename"], "pa_ss_wd");
}

#[tokio::test]
async fn upload_rejects_oversized_file() {
    let h = BeHarness::start().await;
    // 26 MB exceeds the 25 MB cap.
    let big = vec![0u8; 26 * 1024 * 1024];
    let part = Part::bytes(big)
        .file_name("big.bin")
        .mime_str("application/octet-stream")
        .unwrap();
    let form = Form::new().part("file", part);
    let res = h
        .post_auth("/api/uploads")
        .multipart(form)
        .send()
        .await
        .unwrap();
    // axum's DefaultBodyLimit returns 413; manual size check would
    // also return 413. Either way we expect a 4xx.
    assert!(
        res.status() == 413 || res.status() == 400,
        "expected 4xx, got {}",
        res.status()
    );
}

#[tokio::test]
async fn upload_raw_rejects_path_traversal() {
    let h = BeHarness::start().await;
    let res = h
        .get_auth("/api/uploads/..%2Fetc%2Fpasswd/raw")
        .send()
        .await
        .unwrap();
    // ../etc/passwd contains `/` once decoded by the router; that
    // makes it not a single path segment, so the route doesn't match
    // -> 404. Either 404 or 400 is acceptable for this assertion.
    assert!(
        res.status() == 404 || res.status() == 400,
        "got {}",
        res.status()
    );
}

#[tokio::test]
async fn upload_post_with_no_file_part_returns_400() {
    let h = BeHarness::start().await;
    let form = Form::new().text("notfile", "x");
    let res = h
        .post_auth("/api/uploads")
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}
