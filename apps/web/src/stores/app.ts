// Global app state using Solid stores.

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { api, type Chat, type Project, type Theme, type Worktree } from "../api/client";

export interface AppState {
  ready: boolean;
  probed: boolean;
  authError: string | null;
  authRequired: boolean;
  projects: Project[];
  selectedProjectId: string | null;
  worktrees: Record<string, Worktree[]>;
  selectedWorktreeId: string | null;
  chats: Record<string, Chat[]>;
  selectedChatId: string | null;
  themes: Theme[];
  themeId: string;
}

export const [state, setState] = createStore<AppState>({
  ready: false,
  probed: false,
  authError: null,
  authRequired: true,
  projects: [],
  selectedProjectId: null,
  worktrees: {},
  selectedWorktreeId: null,
  chats: {},
  selectedChatId: null,
  themes: [],
  themeId: "dark-default",
});

export const [activePane, setActivePane] = createSignal<
  "chat" | "editor" | "diff" | "terminal" | "queue" | "notes"
>("chat");

export async function refreshProjects() {
  try {
    const list = await api.listProjects();
    setState("projects", list);
    if (!state.selectedProjectId && list.length > 0) {
      setState("selectedProjectId", list[0]!.id);
      await refreshWorktreesForCurrent();
    }
  } catch (e) {
    if (e instanceof Error) setState("authError", e.message);
  }
}

export async function refreshWorktreesForCurrent() {
  const pid = state.selectedProjectId;
  if (!pid) return;
  const list = await api.listWorktrees(pid);
  setState("worktrees", pid, list);
  if (!state.selectedWorktreeId && list.length > 0) {
    setState("selectedWorktreeId", list[0]!.id);
    await refreshChatsForCurrent();
  }
}

export async function refreshChatsForCurrent() {
  const wid = state.selectedWorktreeId;
  if (!wid) return;
  const list = await api.listChats(wid);
  setState("chats", wid, list);
  if (!state.selectedChatId && list.length > 0) {
    setState("selectedChatId", list[0]!.id);
  }
}

export function selectProject(id: string) {
  setState("selectedProjectId", id);
  setState("selectedWorktreeId", null);
  setState("selectedChatId", null);
  void refreshWorktreesForCurrent();
}

export function selectWorktree(id: string) {
  setState("selectedWorktreeId", id);
  setState("selectedChatId", null);
  void refreshChatsForCurrent();
}

export function selectChat(id: string) {
  setState("selectedChatId", id);
}

export async function bootstrap() {
  // Confirm reachability. If /whoami succeeds without a stored token,
  // the server has auth disabled.
  try {
    await api.whoami();
    setState("authRequired", !!api.getToken());
  } catch (e) {
    if (e instanceof Error) setState("authError", e.message);
    setState("ready", true);
    return;
  }
  setState("authError", null);
  // Load themes and projects.
  try {
    const themes = await api.listThemes();
    setState("themes", themes);
  } catch {
    // ignore — themes are optional
  }
  await refreshProjects();
  setState("ready", true);
}

export function setTheme(themeId: string) {
  setState("themeId", themeId);
  const t = state.themes.find((x) => x.id === themeId);
  if (!t) return;
  const root = document.documentElement;
  root.setAttribute("data-theme", t.kind);
  // Switch the active background/foreground; the rest of the surface
  // scale derives from these in styles.css via the [data-theme="*"]
  // selectors. We additionally let the theme override the accent.
  root.style.setProperty("--ag-bg", t.colors.bg);
  root.style.setProperty("--ag-fg", t.colors.fg);
  root.style.setProperty("--ag-fg-muted", t.colors.muted);
  root.style.setProperty("--ag-accent", t.colors.accent);
  localStorage.setItem("ag-theme", themeId);
}
