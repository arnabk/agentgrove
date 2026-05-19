# Running tests

All `just` recipes work on Linux, macOS, and Windows.

| Layer              | Command                | Notes                                |
| ------------------ | ---------------------- | ------------------------------------ |
| L1 unit (BE)       | `just test-unit`       | `cargo test --workspace --lib`       |
| L2 component (BE)  | `just test-component`  | `cargo test --workspace --tests`     |
| L4 BE endpoint E2E | `just test-be-e2e`     | boots real server, hits every route  |
| L1 unit (FE)       | `just test-fe-unit`    | Vitest                               |
| L2 stories         | `just test-stories`    | Storybook test-runner                |
| L5 FE E2E          | `just test-fe-e2e`     | Playwright                           |
| Full live          | `just test-live`       | release binary + BE E2E + Playwright |
| Everything         | `just check`           | fmt, lint, all of the above          |

## Coverage

- `just coverage-be` runs `cargo llvm-cov` and writes `target/llvm-cov/`.
- `just coverage-fe` runs Vitest with V8 coverage.

## Property + mutation + fuzz

- `just test-property` — long-running `proptest` runs.
- `just test-mutation` — `cargo mutants` on changed crates.
- `just fuzz <target>` — runs `cargo fuzz` for that target.

## CI parity

`just check` mirrors the required PR jobs in `.github/workflows/ci.yml`.
