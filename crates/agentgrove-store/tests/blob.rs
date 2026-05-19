//! Component tests for the blob store. Real filesystem, real I/O.

use agentgrove_store::{BlobStore, Sha256};
use tempfile::tempdir;

#[tokio::test]
async fn put_then_get_roundtrips_bytes() {
    let dir = tempdir().unwrap();
    let store = BlobStore::new(dir.path());
    let payload = b"hello agentgrove";
    let sha = store.put(payload).await.unwrap();
    let got = store.get(&sha).await.unwrap();
    assert_eq!(got, payload);
}

#[tokio::test]
async fn put_is_idempotent_and_returns_same_digest() {
    let dir = tempdir().unwrap();
    let store = BlobStore::new(dir.path());
    let a = store.put(b"abc").await.unwrap();
    let b = store.put(b"abc").await.unwrap();
    assert_eq!(a, b);
}

#[tokio::test]
async fn contains_reports_presence() {
    let dir = tempdir().unwrap();
    let store = BlobStore::new(dir.path());
    let missing = Sha256::of(b"never written");
    assert!(!store.contains(&missing).await.unwrap());
    let sha = store.put(b"present").await.unwrap();
    assert!(store.contains(&sha).await.unwrap());
}

#[test]
fn sha_is_64_hex_chars() {
    let s = Sha256::of(b"x");
    assert_eq!(s.as_str().len(), 64);
    assert!(s.as_str().chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn path_for_uses_two_char_shard() {
    let store = BlobStore::new("/tmp/x");
    let sha = Sha256::of(b"shard");
    let p = store.path_for(&sha);
    let s = sha.as_str();
    let components: Vec<_> = p.components().collect();
    let last = components.last().unwrap().as_os_str().to_string_lossy();
    let shard = components[components.len() - 2]
        .as_os_str()
        .to_string_lossy();
    assert_eq!(last, s);
    assert_eq!(shard, &s[..2]);
}
