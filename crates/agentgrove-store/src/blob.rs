//! Content-addressed blob store.
//!
//! Layout: `<root>/<aa>/<sha256>` where `aa` is the first two hex chars.
//! This sharding keeps any single directory's file count bounded on all
//! supported filesystems (NTFS, APFS, ext4, btrfs).

use sha2::{Digest, Sha256 as Sha256Hasher};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// Hex-encoded SHA-256 digest.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Sha256(String);

impl Sha256 {
    /// Compute the SHA-256 of a byte slice.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        let mut hasher = Sha256Hasher::new();
        hasher.update(bytes);
        Self(hex::encode(hasher.finalize()))
    }

    /// Borrow as `&str`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for Sha256 {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// Content-addressed filesystem store.
#[derive(Debug, Clone)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    /// Create a `BlobStore` rooted at `root`. The directory is created on
    /// first write; this constructor does not touch the filesystem.
    #[must_use]
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    /// Filesystem path for a given digest, relative to the store root.
    /// Pure (no I/O).
    #[must_use]
    pub fn path_for(&self, sha: &Sha256) -> PathBuf {
        let s = sha.as_str();
        // `Sha256::of` always produces 64 hex chars; safe to slice.
        let (shard, _) = s.split_at(2);
        self.root.join(shard).join(s)
    }

    /// Store `bytes`. Returns the resulting digest. Idempotent.
    ///
    /// # Errors
    ///
    /// Returns I/O errors from the underlying filesystem.
    pub async fn put(&self, bytes: &[u8]) -> std::io::Result<Sha256> {
        let sha = Sha256::of(bytes);
        let path = self.path_for(&sha);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        // Write to a temp file then rename for crash-safety.
        let tmp = path.with_extension("tmp");
        {
            let mut f = fs::File::create(&tmp).await?;
            f.write_all(bytes).await?;
            f.sync_all().await?;
        }
        fs::rename(&tmp, &path).await?;
        Ok(sha)
    }

    /// Read a blob by digest.
    ///
    /// # Errors
    ///
    /// Returns I/O errors, notably `NotFound` if the blob is missing.
    pub async fn get(&self, sha: &Sha256) -> std::io::Result<Vec<u8>> {
        fs::read(self.path_for(sha)).await
    }

    /// Check whether a blob exists.
    ///
    /// # Errors
    ///
    /// Returns I/O errors other than `NotFound`.
    pub async fn contains(&self, sha: &Sha256) -> std::io::Result<bool> {
        match fs::metadata(self.path_for(sha)).await {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
}
