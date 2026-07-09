# AgentGrove

[![CI](https://github.com/arnabk/agentgrove/actions/workflows/ci.yml/badge.svg)](https://github.com/arnabk/agentgrove/actions/workflows/ci.yml)
[![Release](https://github.com/arnabk/agentgrove/actions/workflows/release.yml/badge.svg)](https://github.com/arnabk/agentgrove/actions/workflows/release.yml)
[![Nightly](https://github.com/arnabk/agentgrove/actions/workflows/nightly.yml/badge.svg)](https://github.com/arnabk/agentgrove/actions/workflows/nightly.yml)

High-performance, low-footprint, open-source local developer workspace.
Rust backend + SolidJS frontend. Cross-platform (Linux, macOS, Windows).

## Features

See [docs/features.md](docs/features.md) for the full feature list.

## Demo Videos

A quick walkthrough of the AgentGrove workspace — project tree, new-chat dialog, and layout.

<img src="./docs/demos/overview.gif" alt="AgentGrove overview demo" width="100%">

### AI Chat

Ask questions with a real provider; watch token-by-token streaming and tool activity in the timeline.

<img src="./docs/demos/ai-chat.gif" alt="AI chat demo" width="100%">

### Team Chat

Chat with other developers on the same instance from the right-side panel. Unread messages show a dot when the panel is closed.

<img src="./docs/demos/team-chat.gif" alt="Team chat demo" width="100%">

### Prompt Queue

Send follow-up messages while the agent is busy; they enqueue automatically and drain back-to-back.

<img src="./docs/demos/prompt-queue.gif" alt="Prompt queue demo" width="100%">

### Settings

Tabbed settings for appearance, prompt templates, providers, agents, and database backups.

<img src="./docs/demos/settings.gif" alt="Settings demo" width="100%">

### Layout Toggles

Collapse and expand the left rail to make room for the main workspace.

<img src="./docs/demos/left-rail-toggle.gif" alt="Layout toggle demo" width="100%">

## Quick Start

```sh
# Install prerequisites (macOS with Homebrew)
brew install node pnpm just
# Rust toolchain — project pins 1.95 via rust-toolchain.toml
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone and run
git clone https://github.com/arnabk/agentgrove.git
cd agentgrove
just dev    # starts BE (hot reload) + FE (HMR) on http://localhost:5173
```

On Linux, install the same packages with your distro's package manager (e.g., `apt install nodejs pnpm` or `pacman -S node pnpm just`). Windows users can use `winget install Rustlang.Rustup OpenJS.NodeJS pnpm.just` or the [rustup](https://rustup.rs/) and [pnpm](https://pnpm.io/installation) installers.

## Documentation

All detailed docs live under [`docs/`](./docs/):

- [Features](./docs/features.md)
- [Architecture](./docs/architecture/overview.md)
- [Contributing](./docs/CONTRIBUTING.md)
- [Local dev guide](./docs/guides/local-dev.md)
- [Agent providers](./docs/guides/agent-providers.md)
- [Chat & queue routing](./docs/architecture/chat-queue-routing.md)
- [Data safety & restore](./docs/operations/data-safety.md)
- [Comparison with other tools](./docs/comparison.md)
- [ADRs](./docs/adr/)

## License

[MIT](./LICENSE)
