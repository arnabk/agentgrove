# Summary

<!-- One paragraph describing the user-visible change. -->

## TDD

- Failing-test commit: <!-- short SHA, or "n/a (docs-only)" -->
- Passing-test commit: <!-- short SHA -->

## Tests (REQUIRED — both unit and integration)

> AgentGrove requires every PR to add or update **both** unit tests and
> integration tests. PRs without both will be sent back. See
> [docs/CONTRIBUTING.md → Tests are mandatory](../docs/CONTRIBUTING.md#tests-are-mandatory).

### Unit tests added or updated

<!-- List each unit test with file path and what it asserts. Example:
- `crates/agentgrove-api/src/branches.rs` — `tests::switch_creates_then_switches`
  asserts a new branch becomes current after `switch_branch(create=true)`.
- `apps/web/tests/NotesPane.test.tsx` — verifies task-list rendering keeps
  the checkbox aligned with the first line of text.
-->

-

### Integration tests added or updated

<!-- List each integration test with file path and what end-to-end flow
it covers. Example:
- `crates/agentgrove-api/tests/e2e/branches_routes.rs` — `switch_with_create_changes_current_branch`
  hits `POST /api/projects/:id/branch` against a real tempdir git repo and
  asserts `GET /api/projects/:id/branches` reflects the new current branch.
- `apps/web/e2e/chat.spec.ts` — drives create-chat → send-prompt →
  see-response against a live FE+BE.
-->

-

### How to run the new tests locally

```sh
# Backend unit + integration
cargo test --workspace

# Single test target
cargo test -p agentgrove-api --test e2e -- <test_name>

# Frontend unit
pnpm -C apps/web test

# Frontend E2E (Playwright, against live BE)
pnpm -C apps/web test:e2e
```

### Coverage notes

<!-- Anything unusual: skipped flake, opt-in slow test, platform-specific
test, etc. Leave blank if standard. -->

## Checklist

- [ ] `just check` passes locally on my OS.
- [ ] **Both** unit and integration tests added/updated (filled in above).
- [ ] If this adds an HTTP route, `route_inventory.rs` + `coverage.txt`
      are updated and the inventory test passes.
- [ ] Cross-platform: changes do not assume a specific OS / shell / path
      separator.
- [ ] Docs under `docs/` updated when behavior changed.
- [ ] If this is a bug fix, the new test fails on `main` (red-proof).
- [ ] No native browser dialogs (`window.confirm`/`alert`/`prompt`); used
      the themed dialog instead.
- [ ] Conventional Commit prefix in title (`feat:`, `fix:`, `chore:`, `docs:`, etc.).
- [ ] DCO sign-off (`git commit -s`).

## Linked issues

Closes #
