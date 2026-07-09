# AgentGrove vs the field

This page compares AgentGrove to the other tools developers reach for
when they want AI-assisted coding. The goal isn't to claim AgentGrove
wins every row — none of them do. The goal is to give you the matrix
so you can pick the right tool for your situation, and to show where
AgentGrove fits.

The tools are grouped by shape, because comparing across shapes (a
desktop IDE fork vs. a CLI tool vs. a hosted service) is what makes
most "AI editor comparisons" useless.

- **Local-first project workspaces** (where AgentGrove sits):
  AgentGrove, Conductor.build, Tarex.
- **IDE forks**: Cursor, Windsurf (Codeium), Continue.dev (extension).
- **CLI agents**: Claude Code (`claude`), opencode, aider, Charm Crush,
  Amp (Sourcegraph), Goose (Block).
- **Hosted / browser-only**: Replit Agent, Bolt.new, v0, GitHub Copilot
  Workspace.
- **In-editor assistants** (extensions, not standalone): Sourcegraph
  Cody, GitHub Copilot, JetBrains AI Assistant, Zed AI.

We focus most depth on the first group (the cluster AgentGrove
competes in directly); the rest are referenced for context.

## TL;DR — pick the tool that matches your situation

| Situation                                              | Tool                |
| ------------------------------------------------------ | ------------------- |
| "I want one app to manage many projects + many agents" | **AgentGrove**      |
| "I want one app to manage many projects + many agents, hosted by a vendor" | Conductor.build |
| "I want a full IDE that's also an AI agent"            | Cursor or Windsurf  |
| "I just want my existing editor to have AI"            | Continue.dev / Cody / Copilot |
| "I want a terminal CLI"                                | Claude Code / opencode / aider |
| "I want to whip up a UI in a browser"                  | Bolt / v0 / Replit  |

If you can't tell the difference between "agent" and "autocomplete",
you probably want Cursor. If you can — and the difference matters —
keep reading.

## Local-first project workspaces (head-to-head)

### Direct competitors

| Feature                              | **AgentGrove**          | Conductor.build              | Tarex                          |
| ------------------------------------ | ----------------------- | ---------------------------- | ------------------------------ |
| **License**                          | OSS                     | Closed                       | Closed                         |
| **Where it runs**                    | Local (Rust binary)     | Local (Electron) + cloud sync| Local                          |
| **Single binary**                    | Yes (~5.3 MB release)   | No (Electron app ~150 MB)    | No (Electron ~150 MB)          |
| **Multi-project workspace**          | Yes                     | Yes                          | Yes                            |
| **Git worktree-aware chats**         | Yes (native)            | Yes                          | Partial                        |
| **Pluggable agent providers**        | Claude + opencode (more planned) | Claude only        | Claude only                    |
| **Per-chat model + effort override** | Yes                     | No                           | No                             |
| **Prompt queue + auto-drain**        | Yes (FIFO, manual/auto) | No                           | No                             |
| **In-app terminal (PTY)**            | Yes (xterm.js + portable_pty) | Yes (Electron)         | Yes                            |
| **Built-in editor (CodeMirror)**     | Yes (folding, autosave) | No (opens VSCode)            | Yes                            |
| **Rich notes per project**           | Yes (Tiptap scratchpad) | No                           | No                             |
| **Per-project file diff dialog**     | Yes (large modal)       | Yes                          | Yes                            |
| **DB-backed persistence**            | SQLite + WAL            | SQLite                       | SQLite                         |
| **Migration safety (snapshots + CI)**| Yes (ADR-0007 + hook)   | Vendor handles                | Vendor handles                 |
| **Forward-only migration policy**    | Enforced (git hook + CI)| n/a                          | n/a                            |
| **Auto-restore CLI**                 | `just restore-db`       | n/a                          | n/a                            |
| **Encrypted-at-rest API keys**       | XChaCha20-Poly1305      | n/a (uses Claude Code auth)  | n/a                            |
| **No bearer token (loopback trust)** | Yes                     | n/a                          | n/a                            |
| **First-run no-account-required**    | Yes (open + use)        | Account required             | Account required               |
| **Cross-platform (Linux / mac / win)**| Yes (PowerShell mirrors)| macOS + win                  | macOS only (as of writing)     |
| **TDD coverage**                     | 104 BE e2e + 198 unit + 16 FE e2e | Opaque             | Opaque                         |

### Bullets — what makes AgentGrove different

**vs Conductor.build**
- AgentGrove is OSS; Conductor is closed and tied to their managed
  service for sync.
- AgentGrove is a single ~5 MB Rust binary; Conductor is a ~150 MB
  Electron bundle.
- AgentGrove supports multiple agent providers (Claude, opencode,
  more pluggable through the `AgentProvider` trait); Conductor is
  Claude-only today.
- AgentGrove ships a real editor + scratchpad + queue + diff; Conductor
  shells out to VSCode for editing.
- AgentGrove publishes its data-safety policy (ADR-0007) + enforces it
  with a git hook + a CI guard; Conductor's data lifecycle is a black
  box you have to trust.

**vs Tarex**
- AgentGrove runs on Linux + macOS + Windows; Tarex is macOS-only.
- Same OSS / size / multi-provider deltas as Conductor.

## IDE forks (Cursor, Windsurf, Continue.dev)

These are full code editors with AI bolted in. AgentGrove is the
opposite: a workspace that manages projects + agents + terminals, with
a small editor for quick edits. You will keep using your real editor
(VSCode, Zed, JetBrains, vim) alongside AgentGrove for big refactors.

| Feature                          | AgentGrove          | Cursor             | Windsurf (Codeium) | Continue.dev (ext.) |
| -------------------------------- | ------------------- | ------------------ | ------------------ | ------------------- |
| Shape                            | Workspace + agents  | IDE                | IDE                | VSCode extension    |
| OSS                              | Yes                 | No                 | No                 | Yes                 |
| Single small binary              | Yes (~5 MB)         | No (~500 MB+)      | No (~500 MB+)      | Embeds in VSCode    |
| Multi-project at once            | First-class         | One window per project | One window per project | Per-VSCode-window |
| Multi-agent (mix Claude + others)| Yes                 | One at a time      | One at a time      | Yes (per chat)      |
| Worktree-aware chats             | Yes                 | No                 | No                 | No                  |
| Prompt queue                     | Yes                 | No                 | No                 | No                  |
| Tab-AI per project               | Yes                 | n/a                | n/a                | n/a                 |
| Tool auto-approve toggle         | Yes (global + per-chat) | "YOLO mode"    | Similar            | Manual              |
| BYO model / OpenAI-compat        | Yes (HTTP providers WIP) | Limited       | Yes                | Yes                 |

**When you want a Cursor / Windsurf**: you want one tool, you live in
the editor full-time, AI is the autocomplete + diff helper.

**When you want an AgentGrove**: you spend half your day shuffling
between many projects + many agents (PR review, code-gen, doc-gen,
test-gen) and you want one place that holds the queue, the chats, and
the diff for each.

## CLI agents (Claude Code, opencode, aider, …)

AgentGrove does not replace these — it WRAPS them. The default agent
provider in AgentGrove is Claude Code; opencode is shipped too. Aider
support is on the roadmap (add an `AgentProvider` impl).

| Feature                       | AgentGrove + Claude/opencode | Bare Claude Code | Bare opencode   | aider          |
| ----------------------------- | ---------------------------- | ---------------- | --------------- | -------------- |
| GUI                           | Yes (workspace + editor)     | No (TUI)         | TUI             | No (CLI)       |
| Multi-chat at once            | Yes                          | One session/term | One session/term| One session/term|
| Persists chat history         | Yes (SQLite, restorable)     | Limited          | Limited         | Markdown files |
| Prompt queue                  | Yes                          | No               | No              | No             |
| Diff view                     | Yes (large dialog)           | No               | TUI             | Terminal patch |
| Multi-project juggling        | Native                       | One per terminal | One per terminal| One per dir    |
| Cost: when you're already in a terminal | n/a (you'd use the CLI directly) | Best  | Best            | Best           |

The CLIs are best when you're already at the terminal and don't want
to context-switch. AgentGrove is best when the context switch is
exactly what you do all day.

## Hosted / browser-only (Replit, Bolt, v0)

Different category entirely — these are "describe what you want, run
in our cloud, watch it build". You DON'T install anything; you DON'T
own the runtime. AgentGrove is the inverse: everything local, you own
the data, the agent talks to your real working tree.

Useful for: prototyping a UI from scratch in 5 minutes (Bolt, v0),
hackathons (Replit Agent), throwaway projects.

Not useful for: long-running real codebases that already exist on
your disk and need to be modified surgically.

## In-editor assistants (Cody, Copilot, JetBrains AI, Zed AI)

These bolt into your existing editor. AgentGrove is comfortable next
to any of them — they handle the autocomplete-while-typing surface,
AgentGrove handles the "run an agent on this whole feature" surface.

## Memory comparison

Measured on a 2025 dev workstation (macOS, M-series). Numbers are
resident set size (RSS) at idle with one project loaded. Vendor
figures are best-effort and approximate — every tool fluctuates with
codebase size + open files + extensions.

| Tool                | Process(es)                       | Idle RSS     | Notes |
| ------------------- | --------------------------------- | ------------ | ----- |
| **AgentGrove (release)** | `agentgrove-server` (Rust)    | **~80 MB**¹  | Single binary. FE runs in your browser tab (adds 100-200 MB depending on browser). |
| **AgentGrove (debug)**   | `agentgrove-server`           | ~80 MB       | Used during `just dev`. Release builds are typically smaller still. |
| Claude Code (CLI)   | `claude` (Node)                   | ~60 MB       | Spawned per turn by AgentGrove. |
| opencode (CLI)      | `opencode` (Bun)                  | ~50 MB       | Spawned per turn by AgentGrove. |
| aider               | `aider` (Python)                  | ~80 MB       | |
| Conductor.build     | Electron app                      | ~600-800 MB  | Vendor's Electron baseline. |
| Tarex               | Electron app                      | ~600-800 MB  | Same Electron baseline. |
| Cursor              | Electron + extensions             | ~700-1200 MB | Full VSCode fork. |
| Windsurf            | Electron + extensions             | ~700-1200 MB | Full VSCode fork. |
| Zed (with AI)       | Native (`zed`)                    | ~150 MB      | Best in class for native editors. |
| Continue.dev        | Adds to VSCode (~50 MB delta)     | host + ~50 MB| Lives inside VSCode. |
| JetBrains AI        | Adds to IDE (varies)              | host + ~100 MB | Lives inside the JVM. |
| Replit / Bolt / v0  | Browser tab                       | 0 (cloud)    | Your browser holds the UI; the runtime is theirs. |

¹ Measured live on the AgentGrove dev machine via
  `GET /api/diag/memory` on the running server: `rss_bytes: 82427904`
  = 78.6 MB. Release binary on disk: 5.3 MB.

### Why AgentGrove is small

- **Rust, not Electron.** Electron's baseline is ~150-200 MB before
  your code; AgentGrove's release binary is ~5 MB and the runtime
  RSS sits well under 100 MB.
- **The FE is a normal browser tab.** You bring your own browser. We
  don't ship Chromium.
- **The agent CLIs are spawned per turn, not kept resident.** Each
  Claude/opencode call lives for one prompt-to-completion turn then
  exits. No always-on agent process eating memory between turns.

If you want a hard upper bound, even with 10 chats open + a busy
terminal + the editor showing a 2k-line file, AgentGrove stays well
under 200 MB total RSS. Conductor and the IDE forks start there.

## Performance comparison

Subjective + workload-dependent, but the rough numbers below give an
indication. All measured on the same M-series workstation.

| Action                                       | AgentGrove        | Cursor       | Conductor    | Claude Code CLI |
| -------------------------------------------- | ----------------- | ------------ | ------------ | --------------- |
| Cold start to ready-to-type                  | < 1 s             | 3-5 s        | 2-4 s        | 0.5 s           |
| Switch project                               | Instant (FE only) | 3-5 s (new window) | 1-2 s | n/a (per-shell) |
| Open file (1 MB)                             | < 100 ms          | < 200 ms     | n/a (defers to VSCode) | n/a |
| Type latency in composer                     | < 16 ms (Solid + Tiptap) | < 16 ms (CodeMirror) | < 16 ms | n/a |
| Terminal output rendering (xterm.js)         | 60 FPS            | 60 FPS       | 60 FPS       | Native TTY      |
| Agent turn dispatch (BE work, excludes provider RTT) | < 50 ms | n/a | n/a | n/a |
| Git status of large repo (10k files)         | < 200 ms          | n/a          | n/a          | `git status` itself |

## Data ownership + safety

This is the row most "AI editor comparisons" skip. We don't.

| Concern                          | AgentGrove          | Cursor       | Conductor    | Hosted (Bolt/Replit) |
| -------------------------------- | ------------------- | ------------ | ------------ | -------------------- |
| Chats + prompts stored locally   | Yes (SQLite)        | Cloud (some local cache) | Local + cloud | Cloud  |
| Source code leaves your machine  | Only your agent call (Claude/opencode CLI) | Some inference cloud | Yes | Yes |
| You can `git grep` your own chat history | Yes (just read the SQLite)  | No   | Partial      | No                   |
| Schema migrations are forward-only | Enforced (ADR-0007 + git hook + CI) | n/a | Vendor managed | n/a  |
| Restore last good state          | `just restore-db <snapshot>` | Vendor support ticket | Vendor support ticket | Lose data |
| Snapshots before every migration | Yes                 | n/a          | n/a          | n/a                  |
| Encryption at rest               | XChaCha20-Poly1305 (provider keys); DB is plaintext (loopback only) | Mixed | Vendor managed | Vendor managed |
| Loopback-only by default         | Yes (127.0.0.1)     | n/a          | n/a          | n/a                  |

If you ship to a regulated industry, "where does my source code go?"
matters. AgentGrove gives you a defensible answer (your machine,
your SQLite file, your gitignored `.data/` directory). The closed
products give you a privacy policy.

## Extensibility

| Surface                          | AgentGrove                     | Cursor                | Conductor   | Claude Code CLI |
| -------------------------------- | ------------------------------ | --------------------- | ----------- | --------------- |
| Add a new agent provider         | Implement `AgentProvider` trait | No                   | No          | n/a             |
| Add a new UI pane                | New `PaneId` + Solid component  | Extensions API       | No          | n/a             |
| Programmatic API                 | HTTP + WebSocket (every route documented) | Limited     | No          | Stdin/stdout    |
| Database access                  | SQLite file is yours            | Opaque               | Cloud + local cache | n/a |
| Source available                 | Yes (OSS license)              | No                    | No          | Yes (CLI)       |

## What AgentGrove is NOT good at (be honest)

- **Live autocomplete while typing.** Use Continue.dev / Copilot /
  Cursor for that. AgentGrove is for "run an agent on this whole
  feature", not "complete this line".
- **Pair-programming on a single file** at the depth of a fork-of-
  VSCode. AgentGrove ships a small CodeMirror editor for quick
  edits; if you're refactoring a 5000-line file, open it in your real
  editor.
- **Browser-only workflow.** You need to install + run the BE
  binary. Replit and Bolt win when "I have no machine, only a tab".
- **Voice + meeting integrations** like some of the hosted offerings
  bundle. AgentGrove is heads-down dev tooling.

## When you'd actually pick AgentGrove

Concrete scenarios where AgentGrove is the right answer:

1. **Many concurrent projects.** You're consulting / contracting / on
   a platform team — three to ten codebases in flight at any moment.
   AgentGrove keeps a per-project chat thread, queue, terminal, and
   notes. Cursor / Windsurf want you to open a fresh window per
   project; AgentGrove lets you flip between them with a left rail.
2. **Worktrees-as-feature-branches** workflow. AgentGrove understands
   `git worktree` natively — every worktree is a first-class scope
   with its own chats, terminals, editor selection, notes. The
   IDE forks see worktrees as just "another path".
3. **Multiple agents in flight.** Run Claude on a refactor in worktree
   A while opencode reviews a PR in worktree B while a third chat
   queues prompts for you to drain when the model has capacity. The
   prompt queue + auto-drain is the closest thing in the field to a
   "task list for the agent".
4. **You care about owning your data.** Source code, chat history,
   project state — all on your disk, all in one SQLite file you can
   query, back up, and restore in one command.
5. **You're contributing back.** AgentGrove is OSS and has explicit
   contribution paths for new providers + new panes + new themes.

## When you'd pick something else

- **You're in one codebase 90% of the time.** Cursor or Windsurf will
  feel more integrated.
- **You want voice / meeting / project-tracker integrations.** Replit
  Agent, Conductor.build, or one of the hosted offerings has a
  broader surface.
- **You're learning to code.** The bigger products' onboarding
  surfaces are friendlier. AgentGrove assumes you know `git
  worktree`.

## Extensibility

---

Last updated: 2026-05-22. Send corrections / additions to
[docs/comparison.md](./comparison.md) — the doc is part of the repo so
PRs are welcome.
