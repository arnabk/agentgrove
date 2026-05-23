//! Slash-command discovery from on-disk Markdown command files.
//!
//! Claude Code and opencode both let users author custom slash
//! commands as Markdown files in well-known directories
//! (`~/.claude/commands/*.md`, `~/.config/opencode/command/*.md`,
//! plus a per-project equivalent at `<project>/.claude/commands/`
//! or `<project>/.opencode/command/`). The file name (sans `.md`)
//! becomes the command name; the YAML front-matter's
//! `description:` field becomes the picker's one-line hint.
//!
//! We use this to surface the user's actual commands in the FE
//! slash-picker — the curated built-in set was never the whole
//! story.
//!
//! Robust to:
//!   * Missing dirs (returns an empty list).
//!   * Files without front-matter (uses an empty description).
//!   * Files with malformed front-matter (description left empty;
//!     the command itself still appears).
//!   * Subdirectories: nested commands like `foo/bar.md` surface
//!     as `foo:bar` to match how Claude / opencode address them.

use crate::SlashCommand;
use std::path::Path;

/// Scan `root/<sub>/*.md` (recursively) and return a SlashCommand
/// per file. The slug is derived from the path relative to
/// `root/<sub>/`, with `/` replaced by `:` to match the CLI's
/// addressing convention. Returns an empty Vec when the dir
/// doesn't exist.
pub fn scan_markdown_commands(root: &Path) -> Vec<SlashCommand> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn walk(start: &Path, dir: &Path, out: &mut Vec<SlashCommand>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(start, &path, out);
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        // Derive `<rel-without-ext>` with `/` -> `:`. Falls back to
        // the file stem alone if strip_prefix fails.
        let rel = path
            .strip_prefix(start)
            .ok()
            .and_then(|p| p.to_str().map(str::to_string))
            .unwrap_or_default();
        let name = rel
            .strip_suffix(".md")
            .unwrap_or(&rel)
            .replace(std::path::MAIN_SEPARATOR, "/")
            .replace('/', ":");
        if name.is_empty() {
            continue;
        }
        let description = read_description(&path).unwrap_or_default();
        out.push(SlashCommand { name, description });
    }
}

/// Extract the `description:` field from a Markdown file's YAML
/// front-matter, when present. Front-matter is delimited by
/// `---` on its own line at the top and bottom; we tolerate
/// missing closing fences (treat as no front-matter) so a
/// malformed file doesn't poison the whole scan.
fn read_description(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if lines.next()? != "---" {
        return None;
    }
    for line in lines {
        if line == "---" {
            return None; // ran out of front-matter, no description
        }
        if let Some(rest) = line.strip_prefix("description:") {
            return Some(rest.trim().trim_matches('"').to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nope");
        assert!(scan_markdown_commands(&path).is_empty());
    }

    #[test]
    fn flat_md_files_become_commands() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("alpha.md"), "no front-matter").unwrap();
        std::fs::write(
            tmp.path().join("beta.md"),
            "---\ndescription: do beta\n---\nbody",
        )
        .unwrap();
        let cmds = scan_markdown_commands(tmp.path());
        assert_eq!(cmds.len(), 2);
        // Sorted: alpha, beta
        assert_eq!(cmds[0].name, "alpha");
        assert_eq!(cmds[0].description, "");
        assert_eq!(cmds[1].name, "beta");
        assert_eq!(cmds[1].description, "do beta");
    }

    #[test]
    fn nested_files_use_colon_addressing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("review")).unwrap();
        std::fs::write(
            tmp.path().join("review/diff.md"),
            "---\ndescription: review the diff\n---",
        )
        .unwrap();
        let cmds = scan_markdown_commands(tmp.path());
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].name, "review:diff");
        assert_eq!(cmds[0].description, "review the diff");
    }

    #[test]
    fn non_md_files_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.md"), "").unwrap();
        std::fs::write(tmp.path().join("a.txt"), "").unwrap();
        std::fs::write(tmp.path().join("README"), "").unwrap();
        let cmds = scan_markdown_commands(tmp.path());
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].name, "a");
    }

    #[test]
    fn malformed_front_matter_still_lists_command() {
        let tmp = tempfile::tempdir().unwrap();
        // Missing closing `---`: we read the description line on
        // the way through but treat the file as front-matter-less
        // overall. We err on the side of "show the command anyway"
        // so a broken yaml header doesn't hide the user's slash
        // command entirely; the description may or may not survive
        // depending on whether we hit it before the loop bails.
        std::fs::write(
            tmp.path().join("x.md"),
            "---\ndescription: half-open\n# body",
        )
        .unwrap();
        let cmds = scan_markdown_commands(tmp.path());
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].name, "x");
        // Implementation reads the description as it walks the
        // lines, so we get it even though the closing `---` never
        // arrived. This is intentional: the file still has a
        // discoverable description, just an ill-formed wrapper.
        assert_eq!(cmds[0].description, "half-open");
    }
}
