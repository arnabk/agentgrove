# Local development

## First-time setup

```sh
git clone https://github.com/<org>/agentgrove
cd agentgrove
just setup
```

`just setup` runs cross-platform: installs Rust components, pnpm
dependencies, and Playwright browsers.

## Running the app

```sh
just dev
```

This starts the Rust server on an ephemeral port and the Vite dev server,
then prints the URL with a temporary token.

## Tests

See [running-tests.md](./running-tests.md).

## Without `just`

Every recipe in the `justfile` has a documented equivalent under
`scripts/`. Use `scripts/<name>.sh` on Unix or `scripts/<name>.ps1` on
Windows.
