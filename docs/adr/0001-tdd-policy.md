# ADR-0001: TDD policy

- Status: Accepted
- Date: 2026-05-18

## Context

AgentGrove is open source. Contributors will arrive with varying styles. To
keep quality high without manual gatekeeping we adopt strict TDD with CI
enforcement.

## Decision

- All behavior changes require a failing test added before the change.
- CI runs a `check-tdd` script that fails if a PR adds non-test production
  lines without adding test lines.
- Bug-fix PRs require a "red-proof" job that runs the new test against
  `main` and verifies it fails.
- Mutation testing tracks assertion quality. Warn-only for 30 days
  post-M1, then enforced on changed files.

## Consequences

- Slightly higher PR friction.
- Confidence to refactor aggressively as the codebase grows.
- Clear contributor signal about quality bar.

## Exceptions

Documentation, formatting, pure renames, and generated code are exempt
when tagged with the appropriate Conventional Commit prefix.
