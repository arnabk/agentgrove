# Integrating an AI agent provider

This guide walks through adding a new provider (Codex, OpenCode,
DeepSeek, MiniMax/Kimi, …) on top of the model we use for Claude.
The architecture is described in
[ADR-0005](../adr/0005-agent-providers-subprocess-passthrough.md);
performance constraints are in
[ADR-0006](../adr/0006-performance-budget-and-virtualization.md). Read
both before starting.

## Core idea

AgentGrove never calls a model API directly. For every supported
provider we:

1. Locate the provider's **official, user-installed CLI** with `which`.
2. Spawn that CLI as a child process inside the worktree directory.
3. Translate the CLI's NDJSON / line-protocol output into our internal
   [`AgentEvent`] enum.
4. Stream events through `LogBus` on a per-chat topic.

The user's existing CLI authentication (API key env var, OAuth
keychain entry, subscription token) is the credential. We don't proxy
logins or take custody of API keys. Compliance with each provider's
ToS is therefore the same as the user running the CLI directly.

## What you implement

### 1. Pick a `ProviderId`

Add a variant to
`crates/agentgrove-agents/src/lib.rs::ProviderId` with the canonical
lowercase wire name (e.g. `Codex`, `OpenCode`). Update `as_str()` to
match. Add a unit test for round-trip serialization.

### 2. Write the translator

Create `crates/agentgrove-agents/src/<provider>.rs`. Implement a
`translate(line: &serde_json::Value) -> Vec<AgentEvent>` function and
unit-test it against fixture lines captured from the real CLI. The
fixtures should cover:

- Whatever the provider calls a session-init event → `SessionStart`
  (capture the provider's session id for `--resume`).
- Text-delta event → `Token { text }`.
- Tool-call event → `ToolCall { name, args, id }`.
- Tool-result event → `ToolResult { name, result, id }`.
- Terminal success → `Done { result, cost_usd }`.
- Terminal failure → `Error { message }`.
- Anything else → drop on the floor (return `vec![]`).

### 3. Implement `AgentProvider`

Implement the trait for a `<Provider>Provider` struct:

```rust
#[async_trait]
impl AgentProvider for MyProvider {
    fn id(&self) -> ProviderId { ProviderId::MyProvider }

    async fn detect(&self) -> ProviderDescriptor { … }

    async fn spawn(
        &self,
        prompt: &str,
        opts: SpawnOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<(), ProviderError> { … }

    async fn slash_commands(
        &self,
        ctx: SlashCommandContext<'_>,
    ) -> Vec<SlashCommand> { … }
}
```

Key contracts:

- `detect()` always returns a descriptor (with `available=false` if the
  CLI is missing). Never error out — the FE renders the picker
  uniformly. `ProviderDescriptor.models` is `Vec<String>`; populate
  with live-fetched data (cached via
  `agentgrove_agents::models_cache::get_or_fetch`) when the CLI
  exposes a `<binary> models` command, otherwise ship a curated
  static set.
- `spawn()` uses `current_dir(opts.cwd)`, `stdin(Stdio::null())`,
  `kill_on_drop(true)`. It must close the events channel exactly once
  per turn (the channel closes naturally when `tx` is dropped at the
  end of `spawn`).
- Forward `opts.model` to the CLI's model flag, falling back to the
  provider's `default_model` when `None`.
- Forward `opts.resume_session_id` when supported so multi-turn chats
  preserve context.
- Honour `opts.auto_approve_tools` — when `true`, pass whatever
  flag the CLI accepts to bypass interactive permission prompts
  (Claude / opencode use `--dangerously-skip-permissions`). Without
  this the agent stalls forever on the first tool call because we
  never allocate a TTY for the child.
- Drain stderr to a separate task so the CLI doesn't block on a full
  pipe; surface unparseable stderr lines as `AgentEvent::Error`
  events.
- Pass the prompt as a positional argument AFTER a `--` separator
  so markdown bullet-list prompts (`- item`) aren't parsed as
  CLI flags.

`slash_commands` is async. The default impl returns an empty list;
override to surface the CLI's commands. The
`agentgrove_agents::slash_files::scan_markdown_commands(root)`
helper walks a directory of `.md` files (Claude / opencode
convention) and reads the YAML front-matter's `description:`
field. Implementations typically union:

  1. **Built-in** commands the CLI always ships.
  2. **User-level** commands from the CLI's per-user config dir
     (`~/.claude/commands/`, `~/.config/opencode/command/`, …).
  3. **Project-level** commands from `<ctx.cwd>/.claude/commands/`
     or `<ctx.cwd>/.opencode/command/` when `ctx.cwd` is set.

### 4. Register the provider

Add an `Arc::new(<Provider>Provider::new())` to
`crates/agentgrove-api/src/providers.rs::ProviderRegistry::default()`.
Add the install hint to
`ProviderDto::from_descriptor`'s match arm.

### 4b. HTTP-API providers (OpenAI-compatible aggregators)

If your provider lives behind an HTTP endpoint rather than a CLI:

- Store its base URL + (optional) API key in the `provider_secrets`
  table via `ProviderSecretRepo`. Keys are encrypted at rest with
  the machine-bound XChaCha20-Poly1305 keyring at
  `<state_dir>/secrets.key`; never round-trip them over HTTP.
- The Settings → Providers tab's `ProviderForm` already wraps the
  encryption + persistence; add an entry to `HTTP_PROVIDERS` in
  `apps/web/src/components/SettingsModal.tsx`.
- Construct the provider on-demand from `providers::resolve()` so
  the runtime config is read at dispatch time, not boot.

### 5. Tests

- **Unit**: translator fixture tests (one per relevant CLI message
  shape) live in the provider module's `#[cfg(test)] mod tests`.
- **Integration**: an L4 endpoint test in
  `crates/agentgrove-api/tests/e2e/providers_routes.rs` should verify
  the new provider appears in `GET /api/providers` and is correctly
  marked available/unavailable based on `which::which(<binary>)`.
- **Scripted spawn**: where possible, add a `FakeProvider`-style
  test in `crates/agentgrove-agents` that exercises the dispatch
  path without depending on the real CLI being present.

### 6. CLI compatibility window

Record the minimum CLI version you tested against in your provider
module's doc comment. Bump it when the upstream NDJSON schema
changes and you depend on the new fields.

## Branding

Follow each provider's brand guidelines. For Anthropic:

- Use the plain name **"Claude"** in user-facing menus.
- Do NOT brand the integration as "Claude Code" or use Claude Code
  visual elements. The AgentGrove product is launching the user's
  installed CLI, not the CLI itself.

Replicate the equivalent restraint for any other provider; check
their developer docs for the canonical label.

## Performance budget

Anything you add must stay inside the per-tab and per-process budgets
in [ADR-0006](../adr/0006-performance-budget-and-virtualization.md):

- Token coalescing already runs in
  `chats::dispatch_via_provider`'s flush loop — keep your
  translator's `AgentEvent::Token { text }` payload as small as the
  CLI gives you. The flush loop will batch.
- Don't allocate per-line state objects in the hot path; reuse
  buffers where the borrow checker allows.
- Don't push raw CLI bytes onto LogBus — emit only the translated
  `AgentEvent`s wrapped in the chat-frame envelope.

## Submitting

CONTRIBUTING.md's "Adding an agent provider" section is the canonical
checklist. Once your translator + provider impl + tests all land,
the FE picker (`NewChatDialog`) and chat dispatch require zero
changes — they read everything from `GET /api/providers` and dispatch
through the trait.
