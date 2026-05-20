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
  | { type: "tool_call"; name: string; args: unknown; id?: string | null }
  | { type: "tool_result"; name: string; result: unknown; id?: string | null }
  | { type: "done"; result: string | null; cost_usd: number | null }
  | { type: "error"; message: string }
  | { type: "truncated"; dropped: number };

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
  supports_resume: boolean;
  install_hint: string;
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

export const api = {
  baseUrl,
  async health() {
    return req<{ status: string; version: string }>("/health");
  },
  // Projects
  listProjects: () => req<Project[]>("/api/projects"),
  createProject: (body: { name?: string; root: string }) =>
    req<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  deleteProject: (id: string) =>
    req<void>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
  deleteWorktree: (projectId: string, worktreeId: string) =>
    req<void>(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`,
      { method: "DELETE" },
    ),
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
  revertPrompt: (chatId: string, promptId: string) =>
    req<Prompt>(
      `/api/chats/${encodeURIComponent(chatId)}/prompts/${encodeURIComponent(promptId)}/revert`,
      { method: "POST" },
    ),
  /** List every agent provider this build knows about (Claude, …). */
  listProviders: () => req<ProviderDescriptor[]>("/api/providers"),
  /** Update mutable chat fields (currently just title). Returns the
   *  fresh windowed ChatView so the FE can refresh its store in one
   *  step. */
  renameChat: (id: string, title: string) =>
    req<ChatView>(`/api/chats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
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
  terminalHistory: (id: string) => req<string>(`/api/terminals/${encodeURIComponent(id)}/history`),
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
    req<TreeEntry[]>(
      `/api/editor/tree?path=${encodeURIComponent(path)}&show_hidden=${showHidden}`,
    ),
  // Git status (changes view)
  gitStatus: (path: string) =>
    req<GitStatusResponse>(`/api/git/status?path=${encodeURIComponent(path)}`),
  // Filesystem browser (folder picker)
  fsHome: () => req<FsHome>("/api/fs/home"),
  fsBrowse: (path: string) =>
    req<FsBrowse>(`/api/fs/browse?path=${encodeURIComponent(path)}`),
  // Themes
  listThemes: () => req<Theme[]>("/api/themes"),
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
  // Diagnostics
  getMemory: () => req<MemoryReport>("/api/diag/memory"),
};

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

/** User preferences persisted at <state_dir>/settings.json on the BE. */
export interface UserSettings {
  theme?: string;
  ui_font?: string;
  mono_font?: string;
  font_size?: number;
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
