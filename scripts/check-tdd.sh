#!/usr/bin/env bash
# check-tdd.sh — verify PR adds tests when it adds production code.
# Counts added non-blank, non-comment lines in production paths and test paths
# between the merge-base of HEAD and the base branch (default: main).
#
# Usage: scripts/check-tdd.sh [base_branch]
#
# Exits non-zero when production lines were added without any test lines.

set -euo pipefail

BASE="${1:-main}"

if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  echo "check-tdd: base branch '$BASE' not found; skipping" >&2
  exit 0
fi

MERGE_BASE="$(git merge-base HEAD "$BASE")"

# Globs treated as production vs test. Keep in sync with check-tdd.ps1.
PROD_PATHS='^(crates/[^/]+/src/|apps/web/src/)'
TEST_PATHS='^(crates/[^/]+/tests/|crates/[^/]+/src/.*test.*|apps/web/(tests|e2e)/|apps/web/src/.*\.(test|spec)\.)'
DOCS_PATHS='^(docs/|README\.md|\.github/|.*\.md$)'

added_lines() {
  local pattern="$1"
  git diff --no-color --unified=0 "$MERGE_BASE" -- \
    | awk -v pat="$pattern" '
        /^\+\+\+ /            { f=substr($0,7); next }
        /^---/                { next }
        /^@@/                 { next }
        /^\+/ {
          if (f ~ pat) {
            line=substr($0,2)
            gsub(/^[ \t]+|[ \t]+$/, "", line)
            if (length(line) == 0) next
            if (line ~ /^(\/\/|#|\/\*|\*)/) next
            count++
          }
        }
        END { print count+0 }'
}

prod_added="$(added_lines "$PROD_PATHS")"
test_added="$(added_lines "$TEST_PATHS")"

# Docs-only changes are exempt regardless of production count.
non_docs_changed="$(git diff --name-only "$MERGE_BASE" -- \
  | grep -Ev "$DOCS_PATHS" || true)"
if [ -z "$non_docs_changed" ]; then
  echo "check-tdd: docs-only change; ok"
  exit 0
fi

echo "check-tdd: added production lines = $prod_added, added test lines = $test_added"

if [ "$prod_added" -gt 0 ] && [ "$test_added" -eq 0 ]; then
  echo "check-tdd: FAIL — production code added without any test changes." >&2
  echo "If this is a justified exception, label the PR 'tdd-exempt' (CI will skip)." >&2
  exit 1
fi

echo "check-tdd: OK"
