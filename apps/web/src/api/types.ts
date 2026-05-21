// Wire types shared by every endpoint module.
//
// Kept in a single file (rather than colocated with each endpoint
// module) so consumers can write `import type { Worktree } from
// "../api/types"` without thinking about which endpoint owns the
// definition. The types here mirror the BE DTOs verbatim — when the
// BE evolves we update this file and let TypeScript drive the FE
// fixes.

export interface Project {
  id: string;
  name: string;
  root: string;
  created_at: string;
  updated_at: string;
  /** Folder is a git repository. */
  is_git?: boolean;
  /** Git repo has at least one remote configured. */
  has_remote?: boolean;
  /** Current branch name (when discoverable). */
  current_branch?: string | null;
  /** Configured git remote names. */
  remotes?: string[];
  /** Project-level pre-worktree script. New worktrees inherit this
   *  unless an explicit per-call override is supplied. `null` /
   *  missing = no project default. */
  pre_worktree_script?: string | null;
}

export interface Worktree {
  id: string;
  project_id: string;
  branch: string;
  base_ref: string;
  path: string;
  status: string;
  pre_script: string | null;
  post_script: string | null;
  created_at: string;
  updated_at: string;
  /** ISO timestamp; non-null only for soft-deleted (history) entries. */
  removed_at?: string | null;
}

/** Chat metadata as returned by list endpoints (no prompts). */
export interface Chat {
  id: string;
  worktree_id: string | null;
  title: string;
  provider: string;
  model: string;
  created_at: string;
  /** Provider session id captured from the first SessionStart event. */
  session_id: string | null;
  /** Inline prompts when this object came from a list endpoint that
   *  embeds them (legacy). New code should use `ChatView`. */
  prompts?: Prompt[];
}

/**
 * Windowed view returned by `GET /api/chats/:id` (ADR-0006). Holds at
 * most `prompts_window` prompts (last N, oldest-first in the array)
 * and each prompt's events are capped at `events_per_prompt`. Use
 * `prompts_total > prompts.length` to decide whether to offer
 * backfill via [`api.listPrompts`].
 */
export interface ChatView {
  id: string;
  project_id: string;
  worktree_id: string | null;
  title: string;
  provider: string;
  model: string;
  /** Provider thinking-effort hint (low | medium | high | xhigh | max). */
  effort: string | null;
  created_at: string;
  session_id: string | null;
  prompts: Prompt[];
  prompts_total: number;
  prompts_window: number;
  events_per_prompt: number;
}

export interface Prompt {
  id: string;
  seq: number;
  content: string;
  events: AgentEvent[];
  touched_paths: string[];
  created_at: string;
}

/** Wire shape matching the BE's `AgentEvent` enum. */
export type AgentEvent =
  | { type: "session_start"; session_id: string }
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; args: unknown; id?: string | null }
  | { type: "tool_result"; name: string; result: unknown; id?: string | null }
  | { type: "done"; result: string | null; cost_usd: number | null }
  | { type: "error"; message: string }
  | { type: "truncated"; dropped: number };

/** Tagged response from the smart-send endpoint. `dispatched` means
 *  the BE has started streaming the agent's reply on the WS topic;
 *  `queued` means the message is parked and will run later. */
export type SendMessageResponse =
  | { kind: "dispatched"; prompt: Prompt }
  | { kind: "queued"; item_id: string };

/** Backfill page returned by `GET /api/chats/:id/prompts?before=`. */
export interface PromptsBackfill {
  prompts: Prompt[];
  at_start: boolean;
}

/** Provider descriptor from `GET /api/providers`. */
export interface ProviderDescriptor {
  id: string;
  label: string;
  available: boolean;
  path: string | null;
  version: string | null;
  default_model: string;
  /** Curated short list of model aliases the provider's CLI accepts.
   *  Drives the model dropdown in the new-chat dialog. Power users
   *  can still type a free-form id in per-chat settings. */
  models: string[];
  supports_resume: boolean;
  install_hint: string;
}

/** A single slash-command surfaced by a provider's CLI. */
export interface SlashCommand {
  name: string;
  description: string;
}

/** Upload metadata returned by `POST /api/uploads`. */
export interface UploadDto {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  /** Absolute path on disk. Embedded in chat prompts so the agent's
   *  Read tool can fetch the file. */
  path: string;
}

export interface Note {
  id: string;
  chat_id: string;
  body: string;
  created_at: string;
}

export interface QueueItem {
  id: string;
  chat_id: string;
  body: string;
  status: "pending" | "running" | "done" | "cancelled";
  created_at: string;
}

export interface QueueState {
  chat_id: string;
  mode: "auto" | "manual";
  items: QueueItem[];
}

export interface Terminal {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface TerminalStatus {
  id: string;
  exited: boolean;
}

export interface Theme {
  id: string;
  name: string;
  kind: "light" | "dark";
  colors: { bg: string; fg: string; muted: string; accent: string };
}

/** Memory readout: backend RSS + each live PTY child's RSS. */
export interface ProcessMemory {
  kind: string;
  pid: number;
  name: string;
  rss_bytes: number;
  virt_bytes: number;
}

export interface MemoryReport {
  backend: ProcessMemory;
  children: ProcessMemory[];
  total_rss_bytes: number;
}

/** Per-project rich-text scratchpad. The body is opaque HTML. */
export interface Scratchpad {
  project_id: string;
  body: string;
  updated_at: string;
}

/** A reusable prompt template the user can insert into a chat. */
export interface PromptTemplate {
  id: string;
  name: string;
  body: string;
}

/** User preferences persisted at `<state_dir>/settings.json` on the BE. */
export interface UserSettings {
  theme?: string;
  ui_font?: string;
  mono_font?: string;
  font_size?: number;
  /** User-defined reusable prompt templates. */
  prompts?: PromptTemplate[];
}

export interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Status entry as returned by `GET /api/git/status`. */
export interface GitStatusEntry {
  path: string;
  orig_path: string | null;
  /** Index (staged) marker, ' ' when clean. */
  x: string;
  /** Working-tree marker, ' ' when clean. */
  y: string;
  modified: boolean;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  untracked: boolean;
  ignored: boolean;
}

export interface GitStatusResponse {
  path: string;
  entries: GitStatusEntry[];
}

/** Response from `POST /api/git/discard`. The `outcome` field tells
 *  the caller exactly what happened so the UI can show a precise
 *  message — restored a tracked file, deleted an untracked one, or
 *  no-op (file was already clean). */
export interface GitDiscardResponse {
  outcome: "restored" | "deleted_untracked" | "noop";
  path: string;
}

export interface FsHome {
  home: string;
  roots: string[];
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  readable: boolean;
}

export interface FsBrowse {
  path: string;
  name: string;
  parent: string | null;
  entries: FsEntry[];
}

/** Also overload `createProject` to accept just `{ root }`. */
export type CreateProjectInput = { root: string; name?: string };
