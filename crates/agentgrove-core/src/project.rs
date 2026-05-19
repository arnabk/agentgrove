//! `Project` domain type.

use crate::{Error, ProjectId, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A project is a folder on disk that the user has registered with
/// AgentGrove. Worktrees and chats hang off projects.
///
/// `root` is stored as an absolute, normalized path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    /// Unique identifier.
    pub id: ProjectId,
    /// Human-readable name. Non-empty after construction.
    pub name: String,
    /// Absolute path to the root folder on disk.
    pub root: PathBuf,
}

impl Project {
    /// Construct a new project.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidInput`] when `name` is empty (after trimming)
    /// or when `root` is not absolute.
    pub fn new(name: impl Into<String>, root: impl AsRef<Path>) -> Result<Self> {
        let name = name.into();
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(Error::InvalidInput("project name must not be empty".into()));
        }
        let root = root.as_ref();
        if !root.is_absolute() {
            return Err(Error::InvalidInput(format!(
                "project root must be absolute: {}",
                root.display()
            )));
        }
        Ok(Self {
            id: ProjectId::new(),
            name: trimmed.to_owned(),
            root: root.to_path_buf(),
        })
    }
}
