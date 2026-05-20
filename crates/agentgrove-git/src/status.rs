//! Working-tree status (`git status --porcelain=v1 -z`).
//!
//! Returns a list of changed paths along with their staged/working-tree
//! markers so a UI can render a VSCode-style "Changes" view.

use std::path::Path;
use tokio::process::Command;

/// One changed entry as reported by git porcelain v1.
#[derive(Debug, Clone)]
pub struct StatusEntry {
    /// Working-tree-relative path.
    pub path: String,
    /// Rename source path, when present.
    pub orig_path: Option<String>,
    /// Index (staged) marker. ' ' when clean.
    pub x: char,
    /// Working tree marker. ' ' when clean.
    pub y: char,
}

impl StatusEntry {
    pub fn is_untracked(&self) -> bool {
        self.x == '?' && self.y == '?'
    }
    pub fn is_ignored(&self) -> bool {
        self.x == '!' && self.y == '!'
    }
    pub fn is_renamed(&self) -> bool {
        self.x == 'R' || self.y == 'R'
    }
    pub fn is_deleted(&self) -> bool {
        self.x == 'D' || self.y == 'D'
    }
    pub fn is_added(&self) -> bool {
        self.x == 'A' || self.y == '?'
    }
    pub fn is_modified(&self) -> bool {
        self.x == 'M' || self.y == 'M'
    }
}

/// Run `git status --porcelain=v1 -z` in `cwd` and return parsed entries.
///
/// Returns an empty vec when the directory is not a git working tree
/// (so the FE can treat "no repo" as "no changes" gracefully).
pub async fn status(cwd: &Path) -> Vec<StatusEntry> {
    let out = match Command::new("git")
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
        ])
        .current_dir(cwd)
        .output()
        .await
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    parse_porcelain_v1_z(&out)
}

fn parse_porcelain_v1_z(buf: &[u8]) -> Vec<StatusEntry> {
    // Records are NUL-terminated. A rename / copy record uses two NULs:
    //   "XY <new>\0<orig>\0"
    // Everything else is a single NUL-terminated record:
    //   "XY <path>\0"
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < buf.len() {
        // Each record starts with two status chars, a space, and then
        // the path.
        if i + 3 > buf.len() {
            break;
        }
        let x = buf[i] as char;
        let y = buf[i + 1] as char;
        // index of the trailing NUL terminator
        let start = i + 3;
        let end = match buf[start..].iter().position(|&b| b == 0) {
            Some(p) => start + p,
            None => buf.len(),
        };
        let path = String::from_utf8_lossy(&buf[start..end]).into_owned();
        let mut orig_path = None;
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            // The original path immediately follows in the next NUL block.
            let osrc_start = end + 1;
            if osrc_start < buf.len() {
                let osrc_end = match buf[osrc_start..].iter().position(|&b| b == 0) {
                    Some(p) => osrc_start + p,
                    None => buf.len(),
                };
                orig_path = Some(String::from_utf8_lossy(&buf[osrc_start..osrc_end]).into_owned());
                i = osrc_end + 1;
            } else {
                i = end + 1;
            }
        } else {
            i = end + 1;
        }
        out.push(StatusEntry {
            path,
            orig_path,
            x,
            y,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_modifications() {
        // " M file.txt\0?? other.txt\0"
        let buf = b" M file.txt\0?? other.txt\0";
        let entries = parse_porcelain_v1_z(buf);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "file.txt");
        assert_eq!(entries[0].x, ' ');
        assert_eq!(entries[0].y, 'M');
        assert_eq!(entries[1].path, "other.txt");
        assert!(entries[1].is_untracked());
    }

    #[test]
    fn parses_rename_record() {
        // "R  new.txt\0old.txt\0"
        let buf = b"R  new.txt\0old.txt\0";
        let entries = parse_porcelain_v1_z(buf);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "new.txt");
        assert_eq!(entries[0].orig_path.as_deref(), Some("old.txt"));
        assert!(entries[0].is_renamed());
    }
}
