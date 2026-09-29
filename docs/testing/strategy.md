# Testing strategy

Five distinct layers. Each separately runnable, separately gated. TDD is
mandatory; see [tdd-policy.md](./tdd-policy.md).

## Layers

```
L1 Unit            (pure functions, fast)
L2 Component       (BE: per-crate integration; FE: Solid component + Storybook)
L3 Contract        (OpenAPI + WS schema conformance)
L4 BE endpoint E2E (real axum, real SQLite, real gix, real pty)
L5 FE/App E2E      (Playwright against real built binary)
```

## Backend

- Unit: `cargo test --lib` per crate.
- Component: `cargo test --tests`. Real SQLite per-test, tempdir repos.
- Contract: regenerate OpenAPI + WS JSON Schema; diff against committed.
- BE E2E: `crates/agentgrove-api/tests/e2e` boots the real server
  (in-process + subprocess smoke). Every route + every WS channel covered.
  Route inventory enforced.
- Property: `proptest` for snapshot/diff/queue.
- Fuzz: `cargo-fuzz` targets for agent stream parsers.
- Mutation: `cargo-mutants` on core crates. Warn-only for 30 days post-M1
  then gate.
- Performance: `criterion` benches with baseline JSON. >10% regression fails.

## Frontend

- Unit: Vitest + `@solidjs/testing-library`.
- Component: Storybook 8 + test-runner.
- Contract: types generated from OpenAPI; `tsc --noEmit` is a gate.
- App E2E: Playwright drives chromium on PR, firefox + webkit nightly.
  Global setup builds release binary and boots it on ephemeral port.
  Two projects: `chromium` (Desktop Chrome) runs everything except
  `mobile-*.spec.ts`; `mobile` (Pixel 7 — real touch, DPR and mobile UA)
  runs only those. Pick one with `--project=`.
- Visual regression: Playwright snapshots, per-OS in nightly.
- Accessibility: `@axe-core/playwright`, zero serious/critical.
- Performance: Lighthouse CI budgets.

## Live full-stack run

`scripts/test-live.sh` + `scripts/test-live.ps1` build the release binary,
boot it, then run BE endpoint suite + Playwright suite against the same
running process. This is the canonical "everything works" gate.

## Coverage thresholds

- Backend: lines ≥85%, branches ≥80%.
- Frontend: lines ≥85%, branches ≥80%.

## Test data

- `tests/fixtures/repos/` minimal git repos as tarballs.
- `tests/fixtures/agents/<provider>/*.ndjson` recorded streams.
- Deterministic clocks and IDs via injectable `Clock` and `IdGen`.

## Running Playwright locally

```sh
pnpm -C apps/web test:e2e                      # both projects, bundled chromium
pnpm -C apps/web exec playwright test --project=mobile
```

Two escape hatches for machines where `playwright install` can't reach the
CDN (e.g. a TLS-intercepting corporate proxy). Neither changes CI, which
installs the bundled browsers:

| Variable        | Effect                                                    |
| --------------- | --------------------------------------------------------- |
| `PW_CHANNEL`    | Drive an installed browser instead, e.g. `PW_CHANNEL=chrome` |
| `PW_NO_VIDEO=1` | Skip failure video, which needs Playwright's bundled ffmpeg |

Against an already-running `just dev` stack:

```sh
PW_LIVE=1 BASE_URL=http://localhost:5173 \
  pnpm -C apps/web exec playwright test --project=mobile
```
