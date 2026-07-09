# Features

AgentGrove is a high-performance, low-footprint local developer workspace. Here is a complete tour of what it can do today.

## Demo Videos

A quick walkthrough of the AgentGrove workspace — project tree, new-chat dialog, and layout.

<video src="./demos/overview.webm" controls muted loop width="100%"></video>

### AI Chat

Ask questions with a real provider; watch token-by-token streaming and tool activity in the timeline.

<video src="./demos/ai-chat.webm" controls muted loop width="100%"></video>

### Team Chat

Chat with other developers on the same instance from the right-side panel. Unread messages show a dot when the panel is closed.

<video src="./demos/team-chat.webm" controls muted loop width="100%"></video>

### Prompt Queue

Send follow-up messages while the agent is busy; they enqueue automatically and drain back-to-back.

<video src="./demos/prompt-queue.webm" controls muted loop width="100%"></video>

### Settings

Tabbed settings for appearance, prompt templates, providers, agents, and database backups.

<video src="./demos/settings.webm" controls muted loop width="100%"></video>

### Layout Toggles

Collapse and expand the left rail to make room for the main workspace.

<video src="./demos/left-rail-toggle.webm" controls muted loop width="100%"></video>

## Project Management

- **Folder-based projects** — add any folder; name auto-derived from the path
- **BE-driven folder picker** — no native file dialog needed; browse the filesystem from the UI
- **Multi-project support** — multiple projects open simultaneously with independent expand/collapse
- **Per-project settings** — pre-worktree scripts, inherited by every worktree
- **Project-scoped state** — each project/worktree gets its own tabs, editor state, and chat history

## Git & Worktrees

- **Git worktree management** — create, rename, delete worktrees from the UI
- **Remote-only worktrees** — worktrees gated on projects with a configured git remote
- **Pre-fetch from remote** — always pulls latest remote before creating a worktree
- **Pre/post scripts** — run setup commands (e.g. `pnpm install`) with live console output
- **Worktree history** — soft-deleted worktrees can be searched and restored
- **Branch switching** — switch branches from the UI with a branch picker
- **Random branch names** — unique two-word suggestions with hex-suffix fallback for collisions
- **VSCode-style git diff** — staged/unstaged file groups with inline CodeMirror merge view
- **Per-file discard** — restore tracked files or delete untracked, with confirmation

## Editor

- **CodeMirror 6 editor** — syntax highlighting for JS/TS, JSON, Markdown, Rust, and more
- **Autosave** — debounced 600ms + blur + file-switch + Cmd/Ctrl+S; no save button needed
- **Code folding** — fold/unfold with gutter markers and keyboard shortcuts
- **File size guard** — large files blocked to prevent crashes
- **Disabled state** — editor disabled with helpful message when no file is selected

## Terminal

- **WebSocket-powered terminal** — bidirectional WS for instant output streaming and keystroke delivery
- **Multiple terminals** — unlimited terminal tabs per project/worktree
- **Per-project cwd** — terminals open in the correct project or worktree directory
- **Auto-close on exit** — Ctrl+D / `exit` closes the tab within ~200ms
- **Session persistence** — terminal sessions survive page refresh (PTY stays alive on BE)
- **Resize sync** — xterm dimensions synced to backend PTY on window resize

## AI Chat

- **Multi-provider** — Claude and opencode supported via CLI subprocess passthrough (legal, user-authenticated)
- **Live model discovery** — models fetched live from providers with cache + manual refresh
- **Per-chat settings** — model, effort (thinking level), slash commands configurable per chat
- **Streaming responses** — real-time token streaming via WebSocket with coalescing (64B/50ms)
- **Markdown rendering** — assistant output rendered with `marked` + `DOMPurify`; syntax-highlighted code blocks
- **Thinking blocks** — extended thinking events rendered as collapsible disclosure blocks
- **Tool activity rail** — tool calls displayed as icon + name + command preview rows
- **File upload & paste** — drag-drop, paste, or attach files; absolute paths appended to prompt
- **Chat forking** — fork a conversation from any point to explore a different direction
- **Message resend** — re-trigger any user message to re-run it through the agent
- **Prompt revert** — ask AI to undo the file changes a specific prompt produced
- **Delete from point** — truncate the conversation from any prompt onwards, clearing the timeline to that point
- **Copy buttons** — hover to copy user or assistant messages
- **Smart input** — Tiptap rich-text composer with bullet/number/blockquote/code-fence autoformat
- **Slash commands** — `/` menu with provider commands + user-defined prompt templates
- **PR detection** — auto-detects GitHub PR URLs in agent output; shows PR badge in chat header
- **Session resume** — Claude uses `--resume`, opencode uses `--session` + `--dir` for continuity
- **Auto-approve tools** — `--dangerously-skip-permissions` flag with per-chat override
- **Stop button** — cancel in-flight agent turns; kills the CLI subprocess cleanly

## Team Chat

- **Real-time communication** — chat with other developers using the same dev instance
- **WebSocket delivery** — instant message broadcast via existing `/ws` channels
- **Persistent history** — team chat messages are saved to the local SQLite database

## Prompt Queue

- **Per-chat queue** — messages sent while AI is busy auto-enqueue
- **Auto-drain** — in auto mode, queued items dispatch back-to-back after each turn
- **Manual mode** — toggle to hold queue items until explicit "Run next"
- **Inline editing** — double-click queue items to edit text; attachments preserved
- **Reorder** — drag queue items up/down to change execution order
- **Right-side dock** — always-visible queue panel inside the chat pane, resizable

## Notes / Scratchpad

- **Per-project rich-text scratchpad** — Tiptap editor with headings, bullets, numbers, checkboxes, code, quotes, links
- **Drag-to-reorder** — grab handle in left gutter to move blocks up/down
- **Rounded checkboxes** — transparent-bg custom checkbox styling
- **Autosave** — debounced with blur/visibility-change flush; never overwrites non-empty with empty
- **Cross-instance sync** — edits propagate to other browser tabs/windows via WebSocket

## Reusable Prompt Templates

- **Settings → Prompts** — CRUD for named prompt templates
- **Default seeds** — ships with 9 templates (Create PR, Code review, Explain code, Write tests, Refactor, Debug, Commit message, Summarise, Merge from remote)
- **Quick picker** — sparkle icon in chat input opens prompt list for instant insertion

## File Search (Cmd+P)

- **Fuzzy file finder** — `nucleo-matcher` powered; sub-10ms search across 100k files
- **Gitignore-aware** — uses `ignore` crate's parallel walker (same as ripgrep)
- **Live index** — per-project file index with manual refresh

## Settings

- **Tabbed modal** — Appearance, Prompts, Providers, Agents, Backups
- **Themes** — 4 built-in themes (Dark, Light, Solarized, Tokyo Night) with CSS variable system
- **Fonts** — 10+ Google Fonts presets for UI and mono; live-loaded on selection
- **Font size** — global size control (12–28px) via CSS zoom scaling
- **Provider management** — CLI providers show detection status; HTTP providers have config forms
- **Auto-approve toggle** — global default with per-chat override
- **Database backups** — list snapshots, restore with confirmation, auto-snapshot before migrations

## Memory & Performance

- **Memory indicator** — top-right pill showing AG (app-attributable), BE (Rust RSS), JS+DOM breakdown
- **Subsystem attribution** — tracks chat events, terminal scrollback, editor document, project state
- **Performance budget** — per-prompt 4096-event cap with Truncated sentinel; windowed chat loading (50 prompts)
- **Virtualized timeline** — `@tanstack/solid-virtual` with flow-layout for smooth chat scrolling
- **Delta terminal polling** — WS streams output; no more 200ms HTTP poll loops

## Cross-Instance Sync

- **WebSocket broadcast** — project/worktree/chat/notes mutations propagate to all connected clients
- **Echo suppression** — 3s self-echo guard prevents reload loops on your own edits
- **Layout persistence** — per-scope UI state (active tab, pane, file) persisted to BE via layout API

## Data Safety

- **SQLite persistence** — chats, prompts, events, queue, layout all survive BE restarts
- **Auto-snapshots** — DB snapshotted before every migration; rotated to last 10
- **Forward-only migrations** — pre-commit hook + CI guard prevent editing applied migrations
- **Restore CLI** — `just restore-db <name>` to recover from any snapshot
- **Encrypted secrets** — provider API keys encrypted at rest with XChaCha20-Poly1305

## Developer Experience

- **Release notifications** — AgentGrove checks the latest GitHub release on startup and surfaces an in-app toast when a new version is available
- **Hot reload** — `just dev` runs BE (cargo-watch) + FE (Vite HMR) together
- **Cross-platform** — Linux/macOS/Windows; `.sh` + `.ps1` script pairs; `PathBuf` only
- **Draggable panels** — left rail + right sidebar + queue dock all resizable with min/max constraints
- **Kebab menus** — project/worktree row actions in overflow menus; no icon clipping on narrow rail
- **Custom dialogs** — themed `confirm`/`alert` replace all native dialogs
- **URL routing** — scope/pane/chat/file encoded in URL; refresh restores deep state
- **Invalid path handling** — back-nav to deleted projects redirects with toast notification
- **Min app width** — 1024px floor with horizontal scroll below threshold
- **App icon** — visible in top bar when left rail is collapsed

## Testing & CI

- **118+ BE e2e tests** — every API route covered with L4 endpoint tests
- **20+ FE Playwright specs** — chat routing, scope placement, settings, draft persistence
- **6 scope unit tests** — proven to catch the `:` vs `::` key drift regression
- **Route inventory** — `route_inventory.rs` + `coverage.txt` enforced; missing routes fail CI
- **3 CI badges** — CI, Release, Nightly all green
- **Cross-platform nightly** — ubuntu + macOS + Windows matrix
- **Auto-release** — every merge to main bumps version + builds 4-platform binaries + GitHub Release

## Open Source

- **MIT licensed**
- **Contributing guide** — TDD policy, unit + integration tests mandatory, PR template
- **Code of Conduct** — Contributor Covenant
- **Security policy** — responsible disclosure channel
- **ADRs** — 7 architecture decision records documenting key choices
- **Comparison doc** — detailed matrix vs Cursor, Conductor, Windsurf, aider, and 10+ others
