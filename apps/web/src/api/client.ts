// Lightweight typed API client.
// Token is read from localStorage; base URL from VITE_API_URL or current origin (during prod).

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

/** Drift + PR + forge status for a worktree's branch vs its remote. */
export interface WorktreeRemoteStatus {
  behind: number;
  ahead: number;
  tracking: string | null;
  diverged: boolean;
  pr: {
    number: number;
    title: string;
    state: string;
    url: string;
    source: string;
    review_decision: string | null;
    checks_status: string | null;
    mergeable: boolean | null;
  } | null;
  forge: {
    forge: string;
    cli: string | null;
    cli_installed: boolean;
    install_hint: string | null;
  } | null;
}

/** Chat metadata as returned by list endpoints (no prompts). */
export interface Chat {
  id: string;
  project_id: string;
  worktree_id: string | null;
  title: string;
  provider: string;
  model: string;
  created_at: string;
  /** Provider session id captured from the first SessionStart event. */
  session_id: string | null;
  /** Inline prompts when this object came from a list endpoint that
   *  embeds them (legacy). New code should use ChatView. */
  prompts?: Prompt[];
}

/**
 * Windowed view returned by `GET /api/chats/:id` (ADR-0006). Holds at
 * most `prompts_window` prompts (last N, oldest-first in the array)
 * and each prompt's events are capped at `events_per_prompt`. Use
 * `prompts_total > prompts.length` to decide whether to offer backfill.
 */
export interface ChatView {
  id: string;
  project_id: string;
  worktree_id: string | null;
  title: string;
  provider: string;
  model: string;
  /** Provider thinking-effort hint (low|medium|high|xhigh|max). */
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

/** One mid-turn chat from `GET /api/chats/active`, tagged with the
 *  project/worktree it belongs to so the left rail can show which
 *  scopes are actively working. */
export interface ActiveChat {
  chat_id: string;
  project_id: string;
  worktree_id: string | null;
}

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

/** Wire shape for `GET /api/providers/:id/config`. The plaintext
 *  API key is never returned — only the `has_api_key` flag. */
export interface ProviderConfig {
  provider_id: string;
  base_url: string;
  has_api_key: boolean;
}

/** Upload metadata returned by `POST /api/uploads`. */
export interface UploadDto {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  /** Absolute path on disk. Embedded in chat prompts so the agent's
   *   Read tool can fetch the file. */
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

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

function baseUrl(): string {
  if (typeof window !== "undefined") {
    const persisted = localStorage.getItem("ag-be");
    if (persisted) return persisted;
  }
  const env = import.meta.env.VITE_API_URL as string | undefined;
  if (env) return env;
  if (typeof window !== "undefined") {
    const port = window.location.port;
    if (port === "5173") return "http://127.0.0.1:4317";
  }
  return "";
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const headers = new Headers(opts.headers);
  if (opts.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  html_url: string | null;
  update_available: boolean;
}

export const api = {
  baseUrl,
  async health() {
    return req<{ status: string; version: string }>("/health");
  },
  async version() {
    return req<VersionInfo>("/api/version");
  },
  // Projects
  listProjects: () => req<Project[]>("/api/projects"),
  createProject: (body: { name?: string; root: string }) =>
    req<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  deleteProject: (id: string) =>
    req<void>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Partial-update a project. Today only `pre_worktree_script` is
   *  mutable; empty string OR `null` clears the field, omitted = no
   *  change. */
  updateProject: (id: string, body: { pre_worktree_script?: string | null }) =>
    req<Project>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  // Worktrees
  listWorktrees: (projectId: string) =>
    req<Worktree[]>(`/api/projects/${encodeURIComponent(projectId)}/worktrees`),
  createWorktree: (
    projectId: string,
    body: {
      branch: string;
      base_ref?: string;
      pre_script?: string;
      post_script?: string;
      path?: string;
    },
  ) =>
    req<Worktree>(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteWorktree: (projectId: string, worktreeId: string, opts?: { deleteBranch?: boolean }) => {
    // `delete_branch=true` extends the remove flow to also drop the
    // local branch in the same call (`git branch -D <branch>` after
    // `git worktree remove`). The BE intentionally returns 500 — with
    // a descriptive message — when the worktree is removed but the
    // branch delete fails, so callers can surface that to the user.
    const qs = opts?.deleteBranch ? "?delete_branch=true" : "";
    return req<void>(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}${qs}`,
      { method: "DELETE" },
    );
  },
  renameWorktree: (projectId: string, worktreeId: string, branch: string) =>
    req<Worktree>(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`,
      { method: "PATCH", body: JSON.stringify({ branch }) },
    ),
  // Chat history (soft-deleted) + restore
  listChatHistory: (params?: { projectId?: string; worktreeId?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set("project_id", params.projectId);
    if (params?.worktreeId) qs.set("worktree_id", params.worktreeId);
    if (params?.q) qs.set("q", params.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return req<Chat[]>(`/api/chats/history${suffix}`);
  },
  deleteChat: (chatId: string) =>
    req<void>(`/api/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" }),
  restoreChat: (chatId: string) =>
    req<Chat>(`/api/chats/${encodeURIComponent(chatId)}/restore`, { method: "POST" }),
  // Worktree history (soft-deleted) + restore
  listWorktreeHistory: (params?: { q?: string; projectId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.projectId) qs.set("project_id", params.projectId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return req<Worktree[]>(`/api/worktrees/history${suffix}`);
  },
  restoreWorktree: (worktreeId: string) =>
    req<Worktree>(`/api/worktrees/${encodeURIComponent(worktreeId)}/restore`, {
      method: "POST",
    }),
  worktreeRemoteStatus: (worktreeId: string) =>
    req<WorktreeRemoteStatus>(`/api/worktrees/${encodeURIComponent(worktreeId)}/remote-status`),
  mergePr: (worktreeId: string, prNumber: number, source: string) =>
    req<void>(`/api/worktrees/${encodeURIComponent(worktreeId)}/merge-pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr_number: prNumber, source }),
    }),
  // Chats — worktree-scoped (legacy) + project-scoped (current).
  listChats: (worktreeId: string) =>
    req<Chat[]>(`/api/worktrees/${encodeURIComponent(worktreeId)}/chats`),
  createChat: (worktreeId: string, body: { title: string; provider: string; model: string }) =>
    req<Chat>(`/api/worktrees/${encodeURIComponent(worktreeId)}/chats`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listProjectChats: (projectId: string) =>
    req<Chat[]>(`/api/projects/${encodeURIComponent(projectId)}/chats`),
  /** Cmd+P fuzzy file search across the active project's tree.
   *  First call triggers the BE's lazy index scan (parallel walker,
   *  ignores gitignored paths). Returns hits sorted best-score-first
   *  + a total_indexed count for the palette footer. */
  searchFiles: (projectId: string, query: string, limit = 50) =>
    req<{
      hits: Array<{ path: string; abs: string; score: number }>;
      total_indexed: number;
    }>(
      `/api/projects/${encodeURIComponent(projectId)}/files/search?q=${encodeURIComponent(
        query,
      )}&limit=${limit}`,
    ),
  reindexFiles: (projectId: string) =>
    req<{ indexed: number }>(`/api/projects/${encodeURIComponent(projectId)}/files/reindex`, {
      method: "POST",
    }),
  createProjectChat: (
    projectId: string,
    body: {
      title: string;
      provider: string;
      model: string;
      worktree_id?: string;
    },
  ) =>
    req<Chat>(`/api/projects/${encodeURIComponent(projectId)}/chats`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Chats with an in-flight agent turn (server truth). Used to show
   *  a per-project/worktree "working" indicator in the left rail. */
  activeChats: () => req<ActiveChat[]>(`/api/chats/active`),
  /** Windowed chat view (last N prompts; older fetched via listPrompts). */
  getChat: (id: string) => req<ChatView>(`/api/chats/${encodeURIComponent(id)}`),
  /** Backfill older prompts. Returns at most 200 (server-clamped). */
  listPrompts: (chatId: string, before: number, limit = 50) =>
    req<PromptsBackfill>(
      `/api/chats/${encodeURIComponent(chatId)}/prompts?before=${before}&limit=${limit}`,
    ),
  addPrompt: (chatId: string, content: string) =>
    req<Prompt>(`/api/chats/${encodeURIComponent(chatId)}/prompts`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  /** Smart send: BE decides whether to dispatch immediately or
   *  queue. Returns a tagged response so the caller can update the
   *  UI without having to read busy state. Use this instead of
   *  `addPrompt` + `enqueue` to avoid FE races on stale signals. */
  sendMessage: (chatId: string, content: string) =>
    req<SendMessageResponse>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  /** Cancel the in-flight agent turn for this chat. Kills the
   *  provider subprocess + appends a synthetic `cancelled by user`
   *  error event. Returns 204 on success, 404 when the chat is
   *  already idle. */
  stopChat: (chatId: string) =>
    req<void>(`/api/chats/${encodeURIComponent(chatId)}/stop`, {
      method: "POST",
    }),
  truncateChat: (chatId: string, fromSeq: number) =>
    req<{ deleted_count: number; deleted_prompt_ids: string[] }>(
      `/api/chats/${encodeURIComponent(chatId)}/truncate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_seq: fromSeq }),
      },
    ),
  forkChat: (chatId: string, promptSeq: number) =>
    req<{
      id: string;
      title: string;
      provider: string;
      model: string;
      project_id: string;
      worktree_id: string | null;
      prompts_count: number;
    }>(`/api/chats/${encodeURIComponent(chatId)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt_seq: promptSeq }),
    }),
  revertPrompt: (chatId: string, promptId: string) =>
    req<Prompt>(
      `/api/chats/${encodeURIComponent(chatId)}/prompts/${encodeURIComponent(promptId)}/revert`,
      { method: "POST" },
    ),
  /** List every agent provider this build knows about (Claude, …). */
  listProviders: () => req<ProviderDescriptor[]>("/api/providers"),
  /** Drop the BE's in-memory model cache for `providerId` and return
   *  a fresh descriptor (re-runs `detect()` against the underlying
   *  CLI / HTTP endpoint). Used by the refresh icon in Settings →
   *  Providers and the new-chat model picker. */
  refreshProvider: (providerId: string) =>
    req<ProviderDescriptor>(`/api/providers/${encodeURIComponent(providerId)}/refresh`, {
      method: "POST",
    }),
  /** Update mutable chat fields. Each field is optional; unset
   *  fields leave the corresponding chat property unchanged.
   *
   *  `effort` accepts a string (set), `null` (clear), or omission
   *  (leave alone) — matching the BE's Option<Option<String>>
   *  semantics. */
  updateChat: (
    id: string,
    patch: {
      title?: string;
      model?: string;
      effort?: string | null;
    },
  ) =>
    req<ChatView>(`/api/chats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** Back-compat alias used by the inline rename UI. */
  renameChat: (id: string, title: string) =>
    req<ChatView>(`/api/chats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  /** Slash commands surfaced by a provider's CLI. Pass `projectId`
   *  to include project-scoped Markdown commands living under
   *  `<project_root>/.claude/commands/` or
   *  `<project_root>/.opencode/command/`. */
  listProviderCommands: (providerId: string, projectId?: string) => {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return req<SlashCommand[]>(`/api/providers/${encodeURIComponent(providerId)}/commands${qs}`);
  },
  /** Read a per-provider config (base URL + has_api_key). The
   *  plaintext API key is never returned over HTTP. */
  getProviderConfig: (providerId: string) =>
    req<ProviderConfig>(`/api/providers/${encodeURIComponent(providerId)}/config`),
  /** Upsert a per-provider config. `api_key` semantics:
   *    - omitted/null → leave existing key untouched
   *    - empty string → clear stored key
   *    - non-empty    → encrypt + persist on the BE */
  putProviderConfig: (providerId: string, body: { base_url: string; api_key?: string | null }) =>
    req<ProviderConfig>(`/api/providers/${encodeURIComponent(providerId)}/config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /** Delete the per-provider config row. */
  deleteProviderConfig: (providerId: string) =>
    req<void>(`/api/providers/${encodeURIComponent(providerId)}/config`, { method: "DELETE" }),
  /** Upload one or more files. The FormData should carry parts under
   *  the field name `file`. Returns metadata (including the absolute
   *  path the agent can read) for each upload. */
  uploadFiles: async (files: File[]): Promise<UploadDto[]> => {
    if (files.length === 0) return [];
    const fd = new FormData();
    for (const f of files) fd.append("file", f, f.name);
    const url = `${baseUrl()}/api/uploads`;
    const res = await fetch(url, { method: "POST", body: fd });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as UploadDto[];
  },
  /** Build the URL that streams an upload's raw bytes (used for
   *  thumbnails / previews in the chat input). */
  uploadRawUrl: (id: string) => `${baseUrl()}/api/uploads/${encodeURIComponent(id)}/raw`,
  // Queue
  getQueue: (chatId: string) => req<QueueState>(`/api/chats/${encodeURIComponent(chatId)}/queue`),
  enqueue: (chatId: string, body: string) =>
    req<QueueItem>(`/api/chats/${encodeURIComponent(chatId)}/queue`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  setQueueMode: (chatId: string, mode: "auto" | "manual") =>
    req<void>(`/api/chats/${encodeURIComponent(chatId)}/queue/mode`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  runNextQueue: (chatId: string) =>
    req<QueueItem>(`/api/chats/${encodeURIComponent(chatId)}/queue/next`, {
      method: "POST",
    }),
  cancelQueueItem: (chatId: string, itemId: string) =>
    req<void>(`/api/chats/${encodeURIComponent(chatId)}/queue/${encodeURIComponent(itemId)}`, {
      method: "DELETE",
    }),
  updateQueueItem: (chatId: string, itemId: string, body: string) =>
    req<void>(`/api/chats/${encodeURIComponent(chatId)}/queue/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),
  // Notes
  listNotes: (chatId: string) => req<Note[]>(`/api/chats/${encodeURIComponent(chatId)}/notes`),
  addNote: (chatId: string, body: string) =>
    req<Note>(`/api/chats/${encodeURIComponent(chatId)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  deleteNote: (chatId: string, noteId: string) =>
    req<void>(`/api/chats/${encodeURIComponent(chatId)}/notes/${encodeURIComponent(noteId)}`, {
      method: "DELETE",
    }),
  // Terminal
  listTerminals: () => req<Terminal[]>("/api/terminals"),
  createTerminal: (body?: {
    cwd?: string;
    cols?: number;
    rows?: number;
    project_id?: string;
    worktree_id?: string;
  }) =>
    req<Terminal>("/api/terminals", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  writeTerminal: (id: string, data: string) =>
    req<void>(`/api/terminals/${encodeURIComponent(id)}/write`, {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    req<void>(`/api/terminals/${encodeURIComponent(id)}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols, rows }),
    }),
  killTerminal: (id: string) =>
    req<void>(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Delta-aware history fetch. `since` is the byte offset the
   *  caller already has; the response carries ONLY the new bytes
   *  (or "" when nothing new), the current total, and the exit
   *  flag — one round-trip instead of the old history+status pair. */
  terminalHistoryDelta: (id: string, since: number) =>
    req<{ bytes: string; total: number; exited: boolean }>(
      `/api/terminals/${encodeURIComponent(id)}/history?since=${since}`,
    ),
  terminalStatus: (id: string) =>
    req<TerminalStatus>(`/api/terminals/${encodeURIComponent(id)}/status`),
  // Editor
  readFile: (path: string) =>
    req<{ path: string; content: string }>(`/api/editor/file?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    req<void>("/api/editor/file", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),
  fileDiff: (path: string) =>
    req<{ path: string; head: string; working: string }>(
      `/api/editor/diff?path=${encodeURIComponent(path)}`,
    ),
  listTree: (path: string, showHidden = true) =>
    req<TreeEntry[]>(`/api/editor/tree?path=${encodeURIComponent(path)}&show_hidden=${showHidden}`),
  // Git status (changes view)
  gitStatus: (path: string) =>
    req<GitStatusResponse>(`/api/git/status?path=${encodeURIComponent(path)}`),
  // Per-file discard. `cwd` = working-tree root, `relPath` = repo-
  // relative path of the file to revert. Mirrors VSCode's "Discard
  // changes" row action in ChangesPanel.
  gitDiscard: (cwd: string, relPath: string) =>
    req<GitDiscardResponse>(`/api/git/discard`, {
      method: "POST",
      body: JSON.stringify({ cwd, rel_path: relPath }),
    }),
  // Filesystem browser (folder picker)
  fsHome: () => req<FsHome>("/api/fs/home"),
  fsBrowse: (path: string) => req<FsBrowse>(`/api/fs/browse?path=${encodeURIComponent(path)}`),
  // Themes
  listThemes: () => req<Theme[]>("/api/themes"),
  // Backups (Settings → Backups panel). The actual restore happens
  // via the `just restore-db <name>` shell command — we DON'T
  // overwrite live DB files from a running server because SQLite
  // WAL is in flight; the restore endpoint returns the command
  // the user runs after stopping the BE.
  listBackups: () =>
    req<{
      backups: Array<{
        name: string;
        size_bytes: number;
        created_at_secs: number;
        tag?: string | null;
      }>;
      state_dir: string;
    }>("/api/backups"),
  createBackup: () => req<{ name: string }>("/api/backups", { method: "POST" }),
  restoreBackup: (name: string) =>
    req<{
      snapshot: string;
      snapshot_path: string;
      shell_command: string;
      note: string;
    }>(`/api/backups/${encodeURIComponent(name)}/restore`, {
      method: "POST",
    }),
  // Settings
  getSettings: () => req<UserSettings>("/api/settings"),
  saveSettings: (s: UserSettings) =>
    req<UserSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(s),
    }),
  // Per-project rich-text scratchpad
  getScratchpad: (projectId: string) =>
    req<Scratchpad>(`/api/projects/${encodeURIComponent(projectId)}/scratchpad`),
  saveScratchpad: (projectId: string, body: string) =>
    req<Scratchpad>(`/api/projects/${encodeURIComponent(projectId)}/scratchpad`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    }),
  // Workspace-global note (not tied to a project). Same shape as the
  // per-project scratchpad; the BE returns a reserved project_id.
  getNotes: () => req<Scratchpad>("/api/notes"),
  saveNotes: (body: string) =>
    req<Scratchpad>("/api/notes", {
      method: "PUT",
      body: JSON.stringify({ body }),
    }),
  // Diagnostics
  getMemory: () => req<MemoryReport>("/api/diag/memory"),
  // Layout (per-scope + global UI state) — see
  // `docs/architecture/chat-queue-routing.md` for the session-state
  // model.
  getLayout: () => req<LayoutSnapshot>("/api/layout"),
  putGlobalLayout: (blob: unknown) =>
    req<void>("/api/layout/global", {
      method: "PUT",
      body: JSON.stringify({ blob }),
    }),
  putScopeLayout: (projectId: string, worktreeId: string, blob: unknown) => {
    const qs = new URLSearchParams({ project: projectId });
    if (worktreeId) qs.set("worktree", worktreeId);
    return req<void>(`/api/layout/scope?${qs.toString()}`, {
      method: "PUT",
      body: JSON.stringify({ blob }),
    });
  },
};

/** Wire shape returned by `GET /api/layout`. */
export interface LayoutSnapshot {
  /** Opaque global layout blob. Empty `{}` when nothing is persisted. */
  global: Record<string, unknown>;
  /** Per-scope blobs. `worktree_id` is "" for project-root scopes. */
  scopes: ScopeLayout[];
}

/** Wire shape for a single scope row in the layout snapshot. */
export interface ScopeLayout {
  project_id: string;
  worktree_id: string;
  blob: Record<string, unknown>;
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

/** User preferences persisted at <state_dir>/settings.json on the BE. */
export interface UserSettings {
  theme?: string;
  ui_font?: string;
  mono_font?: string;
  font_size?: number;
  default_provider?: string;
  default_model?: string;
  /** User-defined reusable prompt templates. */
  prompts?: PromptTemplate[];
  /** Global default: auto-approve every agent tool invocation
   *  (Claude / opencode `--dangerously-skip-permissions`). `undefined`
   *  ⇒ BE's shipping default (`true`). */
  auto_approve_tools?: boolean;
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

/** Also overload createProject to accept just { root }. */
export type CreateProjectInput = { root: string; name?: string };

export function openWs(topic: string): WebSocket {
  const url = new URL(baseUrl() || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("topic", topic);
  return new WebSocket(url.toString());
}

/** Open the bidirectional terminal WebSocket for a session. Output
 *  streams as binary frames; keystrokes are sent back over the same
 *  socket. This is the low-latency path that replaces HTTP polling. */
/** A client-side log line to persist on the BE for later debugging. */
export interface ClientLog {
  level?: "error" | "warn" | "info";
  title: string;
  message?: string;
  context?: unknown;
}

/** Fire-and-forget: forward a client log/toast to the BE so it lands
 *  in `<state_dir>/logs/client.log` and the server tracing stream.
 *  Deliberately does NOT use `req` (no throw, no JSON-error parsing)
 *  because a logging failure must never disrupt the UI or recurse
 *  back into another error toast. */
export function logClient(entry: ClientLog): void {
  try {
    void fetch(`${baseUrl()}/api/diag/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never throw from a logging path
  }
}

export function openTerminalWs(id: string): WebSocket {
  const url = new URL(baseUrl() || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/terminals/${encodeURIComponent(id)}/ws`;
  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";
  return ws;
}
