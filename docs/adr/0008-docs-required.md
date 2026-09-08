# ADR-0008: Documentation is required for behavior changes

- Status: Accepted
- Date: 2026-09-08

## Context

AgentGrove has grown a large feature surface (worktrees, AI chat, queue,
database editor, notes, team chat, Galaxy Map, and more). Several
features shipped with tests but without matching documentation, so the
root README feature list and the `docs/` pages drifted behind the code.
Undocumented behavior is hard for users to discover and hard for
contributors to reason about, and it erodes the "single source of truth"
guarantee the README is supposed to provide.

We already enforce that every behavior change ships with tests
(ADR-0001). Documentation deserves the same footing.

## Decision

- Every PR that adds or changes user-visible behavior must add or update
  documentation in the same PR, enforced by review.
- The root [`README.md`](../../README.md) is the single feature catalog.
  There is no `docs/features.md` (it was intentionally removed); new
  user-visible features are added to the README feature list.
- Structural or hard-to-reverse decisions (new dependency, new agent
  provider, storage/format change, cross-cutting pattern) get an ADR
  under `docs/adr/`, linked from `docs/README.md`.
- New or changed HTTP routes update the relevant `docs/architecture/`
  page in addition to the route inventory.
- New developer workflows or gotchas update the matching `docs/guides/`
  page (or `docs/AGENTS.md` for agent-run workflows).
- The contributor checklists in
  [CONTRIBUTING.md](../CONTRIBUTING.md) ("Adding a feature", "Adding a
  route", "Adding an agent provider") each carry an explicit docs step.

## Consequences

- Docs stay in lock-step with the code; the README always reflects what
  the app can do.
- Slightly higher PR friction, consistent with the existing tests-are-
  mandatory bar.
- Reviewers have a clear, citable rule to send back behavior changes
  that lack docs.

## Exceptions

Pure internal refactors, formatting, and renames with no behavior change
are exempt when tagged with the appropriate Conventional Commit prefix
(e.g. `refactor:`, `style:`, `chore:`). If in doubt, write the doc.
