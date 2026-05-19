# TDD policy

AgentGrove is TDD-first. Every behavior change ships with a test that
failed before the change.

## Rules

1. Red → Green → Refactor for every feature and every bug fix.
2. PR description must reference the failing-test commit (or commit range)
   and the passing-test commit.
3. CI runs `scripts/check-tdd.sh` (POSIX) / `scripts/check-tdd.ps1` (Windows)
   to verify: any PR that adds non-test production lines must also add test
   lines. Exceptions: docs, comments, generated code under `target/`,
   `dist/`, `node_modules/`.
4. Bug fix PRs add a regression test. CI's `red-proof` job checks out
   `main`, applies only the new test, and verifies it fails — proving the
   test actually catches the bug.
5. Mutation testing scores are tracked per crate; assertion-weak tests fail
   review.

## Workflow

1. Pick or open an issue. Confirm scope.
2. Write the smallest failing test. Commit (`test: ...`).
3. Implement. Make it pass. Commit (`feat:`/`fix:` ...).
4. Refactor with tests green. Commit (`refactor: ...`).
5. Run `just check` locally before push.

## Exceptions

Generated code, formatting-only changes, documentation, and pure renames
without behavioral change are exempt. They must be tagged `chore:` or
`docs:` and explained in the PR.
