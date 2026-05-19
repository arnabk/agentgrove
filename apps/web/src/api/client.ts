// Lightweight typed API client.
// Token is read from localStorage; base URL from VITE_API_URL or current origin (during prod).

export interface Project {
  id: string;
  name: string;
  root: string;
  created_at: string;
  updated_at: string;
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
}

export interface Chat {
  id: string;
  worktree_id: string;
  title: string;
  provider: string;
  model: string;
  created_at: string;
  prompts: Prompt[];
}

export interface Prompt {
  id: string;
  seq: number;
  content: string;
  events: AgentEvent[];
  touched_paths: string[];
  created_at: string;
}

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

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

function token(): string {
  return localStorage.getItem("ag-token") ?? "";
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const headers = new Headers(opts.headers);
  if (!headers.has("Authorization") && token()) {
    headers.set("Authorization", `Bearer ${token()}`);
  }
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
  setToken(t: string) {
    localStorage.setItem("ag-token", t);
  },
  getToken: token,
  baseUrl,
  async health() {
    return req<{ status: string; version: string }>("/health");
  },
  async whoami() {
    return req<string>("/whoami");
  },
  // Projects
  listProjects: () => req<Project[]>("/api/projects"),
  createProject: (body: { name: string; root: string }) =>
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
  // Chats
  listChats: (worktreeId: string) =>
    req<Chat[]>(`/api/worktrees/${encodeURIComponent(worktreeId)}/chats`),
  createChat: (worktreeId: string, body: { title: string; provider: string; model: string }) =>
    req<Chat>(`/api/worktrees/${encodeURIComponent(worktreeId)}/chats`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getChat: (id: string) => req<Chat>(`/api/chats/${encodeURIComponent(id)}`),
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
  createTerminal: (body?: { cwd?: string; cols?: number; rows?: number }) =>
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
  listTree: (path: string) =>
    req<{ path: string; is_dir: boolean }[]>(`/api/editor/tree?path=${encodeURIComponent(path)}`),
  // Themes
  listThemes: () => req<Theme[]>("/api/themes"),
};

export function openWs(topic: string): WebSocket {
  const url = new URL(baseUrl() || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("topic", topic);
  url.searchParams.set("token", token());
  return new WebSocket(url.toString());
}
