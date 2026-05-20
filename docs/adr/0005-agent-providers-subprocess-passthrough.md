# ADR-0005: Agent providers run as user-installed CLIs (subprocess passthrough)

- Status: Accepted
- Date: 2026-05-20

## Context

AgentGrove needs to host AI coding agents (Claude, Codex, OpenCode,
DeepSeek, MiniMax/Kimi, ...) so users can converse with them inside the
project's worktree, with their changes visible in the editor and diff
view. There are two structurally different ways to integrate them:

1. **Library / API integration.** AgentGrove links against the
   provider's SDK (e.g. `@anthropic-ai/claude-agent-sdk`,
   OpenAI's client library) and calls their HTTP API directly with
   user-supplied credentials.
2. **Subprocess passthrough.** AgentGrove launches the provider's
   *official, user-installed* CLI (e.g. the `claude` binary, `codex`,
   `opencode`) as a child process inside the worktree directory, talks
   to it over stdin/stdout, and treats its NDJSON event stream as the
   source of truth. Authentication, tool execution, model selection,
   and rate-limiting are all handled by the upstream CLI; AgentGrove is
   a UI on top.

The library route gives the tightest integration but creates serious
constraints:

- **License / ToS.** Anthropic's Agent SDK documentation explicitly
  states: *"Unless previously approved, Anthropic does not allow third
  party developers to offer claude.ai login or rate limits for their
  products, including agents built on the Claude Agent SDK. Please use
  the API key authentication methods described in this document
  instead."* In practice this means any product embedding the Agent
  SDK must require users to bring their own API key and cannot
  passthrough a `claude.ai` Pro/Max subscription. The same kind of
  restrictions apply to other providers (OpenAI, Google) — third-party
  use of consumer subscriptions is generally forbidden.
- **Credential handling.** Embedding API integrations means AgentGrove
  has to take custody of API keys, store them securely, and probably
  rotate them. That is a non-trivial security responsibility for a
  local-first dev tool.
- **Provider sprawl.** Each new provider would mean another SDK, its
  own auth flow, its own tool format, and its own update cadence. The
  surface area grows as a multiple of providers.

Other tools in this space — most notably Conductor
(<https://conductor.build>) — pick the subprocess route for exactly
these reasons. Their docs read: *"Conductor uses Claude Code however
you're already logged in. If you're logged into Claude Code with an
API key, Conductor will use that too. If you're logged in with the
Claude Pro or Max plan, Conductor will use that."* It is the same
delegation pattern we already use for `git`.

## Decision

AgentGrove integrates agent providers as **child processes of their
official CLI**.

Concretely:

- A new `AgentProvider` trait in `agentgrove-agents` describes a
  provider abstractly: `detect()`, `default_model()`, `spawn(prompt,
  cwd, session)` -> stream of `AgentEvent`s. Each provider
  implementation locates its CLI via `which`, validates a minimum
  version where applicable, and spawns it in a managed child process.
- The first concrete implementation is `ClaudeProvider`, which calls
  `claude -p <prompt> --output-format stream-json --verbose
  --include-partial-messages` and translates the NDJSON line-protocol
  into our internal `AgentEvent` enum (`Token`, `ToolCall`,
  `ToolResult`, `Done`, `Error`, plus a new `SessionStart` carrying
  the provider's session id for resume).
- AgentGrove **never** ships, embeds, or proxies provider API keys or
  subscriptions. The user's existing CLI authentication (API key
  environment variable, OAuth keychain entry, or subscription token
  managed by the CLI itself) is the credential. We do not pass any
  authentication arguments to the CLI; we let it pick its configured
  source.
- The child runs in the worktree directory so tool-using prompts read
  and write the right files. Stdout flows through `LogBus` on a
  topic like `chat:{chat_id}` and is streamed to the FE over the
  existing `/ws` endpoint.
- Sessions persist between turns by capturing the CLI's session id
  and passing it back via `--resume` on the next turn.

## Branding

Per Anthropic's branding guidelines:

- We name the provider option **"Claude"** in user-facing menus
  (Anthropic's preferred label inside a list of agents).
- We do **not** brand the integration as "Claude Code" or use any
  Claude Code visual elements; we are launching the user's installed
  Claude Code binary, but the AgentGrove UI keeps its own identity.
- The same compliance pattern applies to other providers: we use
  their plain name in the picker.

## Consequences

- **Legal and ToS safety.** AgentGrove never speaks to a provider's
  API directly, never holds API keys, and never proxies a subscription
  login. The user-installed CLI is the integration boundary; the user
  has already accepted that CLI's ToS by installing and authenticating
  it.
- **No bundled credentials.** There is no `ANTHROPIC_API_KEY` field
  in our settings, no key store, no rotation logic.
- **CLI parity for free.** Whatever a provider's CLI can do — Pro
  plan, Bedrock, Vertex, custom MCP servers, plugins — AgentGrove
  inherits automatically.
- **Detection step required.** If the user does not have `claude` (or
  the relevant CLI) on `PATH`, we surface a clear "Install Claude
  Code to enable this provider" error with a link to the official
  install instructions. We do not attempt to auto-install.
- **Higher latency vs library calls.** Process spawn (~50-150ms) plus
  stdio parsing adds a small overhead on each turn. Acceptable for an
  interactive UI; the model latency dominates.
- **Output parsing risk.** If a provider changes its NDJSON schema we
  have to update the adapter. We pin each provider's CLI to a known
  minimum version range and emit a warning when the user is on an
  untested newer version.
- **Sandboxing.** The child runs with the same OS permissions as
  AgentGrove. Per-worktree isolation is left to git (separate
  directory, separate branch); we do not sandbox the CLI further.

## Adding a new provider

1. Add an enum variant and a `ProviderId` constant.
2. Implement `AgentProvider::detect()` (locate binary, check version).
3. Implement `AgentProvider::spawn(prompt, cwd, session)` returning a
   stream of `AgentEvent`s by parsing the CLI's output.
4. Add provider-specific fixtures under
   `crates/agentgrove-agents/tests/fixtures/<provider>/` and a parser
   unit test for each fixture.
5. Add an integration test that spawns a scripted `FakeProvider`
   simulating the real CLI's stream.
6. Register the provider in the BE provider registry and expose it
   via `GET /api/providers`.

## Migration / fallback

If Anthropic (or another provider) later opens a partnership tier
that allows direct subscription passthrough — or publishes a stable
library API with the same auth flexibility — we can add a second
backend behind the same trait without changing the FE protocol.
