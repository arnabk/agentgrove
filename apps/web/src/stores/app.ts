// Global app state using Solid stores.
//
// Per-scope model. A "scope" is either a plain project or a specific
// worktree under that project. Chat / editor / terminal tabs are owned
// by a scope, so selecting a worktree gives you a fresh, isolated
// workspace while the project root's workspace stays untouched (and
// vice versa).
//
// Scope key encoding:
//   "<projectId>"                — project root
//   "<projectId>:<worktreeId>"   — specific worktree of that project
//
// Caps: max 5 chats, 5 terminals per scope (BE also enforces).

import { createStore, produce } from "solid-js/store";
import { createSignal } from "solid-js";
import {
  api,
  type Project,
  type Theme,
  type UserSettings,
  type Worktree,
} from "../api/client";

/** Per-scope cap for chats (max 5 per project/worktree scope). */
export const MAX_PER_PROJECT = 5;

/** Cap for the global terminal pool (5 terminals app-wide). */
export const MAX_GLOBAL_TERMINALS = 5;

export type PaneId = "chat" | "editor" | "terminal" | "notes";

/** Terminal tab — references an active PTY on the BE. */
export interface TerminalTab {
  /** BE PTY session id. */
  id: string;
  /** Working directory. */
  cwd: string;
  /** Human label (auto-generated index). */
  label: string;
}

/** Chat tab — references a chat record on the BE. */
export interface ChatTab {
  id: string;
  title: string;
}

/** Workspace scope: chat/editor/terminal state. Owned by a scope key
 *  (project, or worktree-of-project). */
export interface Scope {
  activePane: PaneId;

  /** Active file in the (single-instance) editor — absolute path. */
  activeEditor: string | null;

  terminals: TerminalTab[];
  activeTerminal: string | null; // pty id

  chats: ChatTab[];
  activeChat: string | null; // chat id
}

function freshScope(): Scope {
  return {
    activePane: "chat",
    activeEditor: null,
    terminals: [],
    activeTerminal: null,
    chats: [],
    activeChat: null,
  };
}

export interface AppState {
  ready: boolean;
  loadError: string | null;
  projects: Project[];
  selectedProjectId: string | null;
  /** Active worktree per project (null = project root scope). */
  selectedWorktreeByProject: Record<string, string | null>;
  worktrees: Record<string, Worktree[]>;
  themes: Theme[];
  themeId: string;
  /** User-tunable preferences loaded from the BE. */
  settings: UserSettings;
  /** Scopes keyed by scopeKey() — see top-of-file comment. */
  byScope: Record<string, Scope>;
}

const DEFAULT_UI_FONT =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DEFAULT_MONO_FONT =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const DEFAULT_FONT_SIZE = 15;

export const [state, setState] = createStore<AppState>({
  ready: false,
  loadError: null,
  projects: [],
  selectedProjectId: null,
  selectedWorktreeByProject: {},
  worktrees: {},
  themes: [],
  themeId: "dark-default",
  settings: {},
  byScope: {},
});

/** Visibility of the global Settings modal. */
export const [settingsOpen, setSettingsOpen] = createSignal(false);

/** Scope passed to the Changes (git diff) overlay. `null` means closed. */
export interface ChangesScope {
  /** Absolute path to the working tree (project root or worktree path). */
  path: string;
  /** Human label for the panel header (project name or branch name). */
  label: string;
}
export const [changesScope, setChangesScope] = createSignal<ChangesScope | null>(null);

// ---- scope key + helpers -----------------------------------------------

/** Encode (projectId, worktreeId|null) into the scope key. */
function makeKey(pid: string, wid: string | null): string {
  return wid ? `${pid}:${wid}` : pid;
}

/** Active scope key based on selectedProjectId + worktree-for-that-project. */
export function currentScopeKey(): string | null {
  const pid = state.selectedProjectId;
  if (!pid) return null;
  const wid = state.selectedWorktreeByProject[pid] ?? null;
  return makeKey(pid, wid);
}

/** Active worktree id of the current project, or null for project root. */
export function currentWorktreeId(): string | null {
  const pid = state.selectedProjectId;
  if (!pid) return null;
  return state.selectedWorktreeByProject[pid] ?? null;
}

function ensureScope(key: string) {
  if (!state.byScope[key]) {
    setState("byScope", key, freshScope());
  }
}

/** Read the active scope, or undefined if no project is selected. */
export function currentScope(): Scope | undefined {
  const key = currentScopeKey();
  if (!key) return undefined;
  return state.byScope[key];
}

export function activePane(): PaneId {
  return currentScope()?.activePane ?? "chat";
}

export function setActivePane(pane: PaneId) {
  const key = currentScopeKey();
  if (!key) return;
  ensureScope(key);
  setState("byScope", key, "activePane", pane);
}

// ---- editor (single file per scope) ------------------------------------

export function selectFile(path: string) {
  const key = currentScopeKey();
  if (!key) return;
  ensureScope(key);
  setState("byScope", key, "activeEditor", path);
  setState("byScope", key, "activePane", "editor");
}

export function selectedFilePath(): string | null {
  return currentScope()?.activeEditor ?? null;
}

export function selectedChatId(): string | null {
  return currentScope()?.activeChat ?? null;
}

// ---- chat tabs ---------------------------------------------------------

export function addChatTab(chat: ChatTab): { ok: boolean; reason?: string } {
  const key = currentScopeKey();
  if (!key) return { ok: false, reason: "no project selected" };
  ensureScope(key);
  const scope = state.byScope[key]!;
  if (scope.chats.find((c) => c.id === chat.id)) {
    setState("byScope", key, "activeChat", chat.id);
    return { ok: true };
  }
  // No per-scope chat cap: users can create as many chats as they want.
  setState(
    "byScope",
    key,
    produce((s) => {
      s.chats.push(chat);
      s.activeChat = chat.id;
      s.activePane = "chat";
    }),
  );
  return { ok: true };
}

/**
 * Replace the active scope's chat tabs with `chats`, preserving the
 * activeChat selection when possible. Used after refreshing the chat
 * list from the BE on scope switch.
 */
export function setScopeChats(chats: ChatTab[]) {
  const key = currentScopeKey();
  if (!key) return;
  ensureScope(key);
  setState(
    "byScope",
    key,
    produce((s) => {
      s.chats = chats;
      if (s.activeChat && !chats.find((c) => c.id === s.activeChat)) {
        s.activeChat = chats[0]?.id ?? null;
      } else if (!s.activeChat && chats.length > 0) {
        s.activeChat = chats[0]!.id;
      }
    }),
  );
}

export function closeChatTab(chatId: string) {
  const key = currentScopeKey();
  if (!key) return;
  setState(
    "byScope",
    key,
    produce((s) => {
      const idx = s.chats.findIndex((c) => c.id === chatId);
      if (idx < 0) return;
      s.chats.splice(idx, 1);
      if (s.activeChat === chatId) {
        s.activeChat = s.chats[Math.min(idx, s.chats.length - 1)]?.id ?? null;
      }
    }),
  );
}

export function setActiveChat(chatId: string) {
  const key = currentScopeKey();
  if (!key) return;
  setState("byScope", key, "activeChat", chatId);
}

// ---- terminal tabs -----------------------------------------------------

export function addTerminalTab(t: TerminalTab): { ok: boolean; reason?: string } {
  const key = currentScopeKey();
  if (!key) return { ok: false, reason: "no project selected" };
  ensureScope(key);
  const scope = state.byScope[key]!;
  if (scope.terminals.find((x) => x.id === t.id)) {
    setState("byScope", key, "activeTerminal", t.id);
    return { ok: true };
  }
  setState(
    "byScope",
    key,
    produce((s) => {
      s.terminals.push(t);
      s.activeTerminal = t.id;
      s.activePane = "terminal";
    }),
  );
  return { ok: true };
}

export function closeTerminalTab(id: string) {
  const key = currentScopeKey();
  if (!key) return;
  setState(
    "byScope",
    key,
    produce((s) => {
      const idx = s.terminals.findIndex((x) => x.id === id);
      if (idx < 0) return;
      s.terminals.splice(idx, 1);
      if (s.activeTerminal === id) {
        s.activeTerminal = s.terminals[Math.min(idx, s.terminals.length - 1)]?.id ?? null;
      }
    }),
  );
}

export function setActiveTerminal(id: string) {
  const key = currentScopeKey();
  if (!key) return;
  setState("byScope", key, "activeTerminal", id);
}

// ---- project + worktree lifecycle --------------------------------------

export async function refreshProjects() {
  try {
    const list = await api.listProjects();
    setState("projects", list);
    // Fetch worktrees for EVERY project so the LeftRail can render them
    // for any expanded project, not just the selected one. This also
    // fixes the "worktrees disappear on refresh" bug.
    await Promise.all(
      list.map(async (p) => {
        try {
          const wts = await api.listWorktrees(p.id);
          setState("worktrees", p.id, wts);
        } catch {
          // skip silently — project root still works
        }
      }),
    );
    if (!state.selectedProjectId && list.length > 0) {
      selectProject(list[0]!.id);
    }
  } catch (e) {
    if (e instanceof Error) setState("loadError", e.message);
  }
}

export async function refreshWorktreesForProject(pid: string) {
  try {
    const list = await api.listWorktrees(pid);
    setState("worktrees", pid, list);
  } catch (e) {
    if (e instanceof Error) setState("loadError", e.message);
  }
}

/** Back-compat alias. */
export async function refreshWorktreesForCurrent() {
  const pid = state.selectedProjectId;
  if (!pid) return;
  await refreshWorktreesForProject(pid);
}

export function selectProject(id: string) {
  setState("selectedProjectId", id);
  // Default to project-root scope when first entering a project; user
  // can switch to a worktree explicitly.
  if (state.selectedWorktreeByProject[id] === undefined) {
    setState("selectedWorktreeByProject", id, null);
  }
  const key = currentScopeKey();
  if (key) ensureScope(key);
  void refreshWorktreesForProject(id);
}

/** Switch the active scope inside the currently-selected project to a
 *  specific worktree, or null to use the project root. */
export function selectWorktree(projectId: string, worktreeId: string | null) {
  // Make sure the project is the selected one — clicking a worktree of a
  // different project should also focus that project.
  if (state.selectedProjectId !== projectId) {
    setState("selectedProjectId", projectId);
  }
  setState("selectedWorktreeByProject", projectId, worktreeId);
  const key = currentScopeKey();
  if (key) ensureScope(key);
}

// ---- bootstrap + settings ----------------------------------------------

export async function bootstrap() {
  try {
    const themes = await api.listThemes();
    setState("themes", themes);
  } catch {
    // themes optional
  }
  try {
    const s = await api.getSettings();
    setState("settings", s);
    applySettings(s);
  } catch {
    applySettings({});
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
  root.style.setProperty("--ag-bg", t.colors.bg);
  root.style.setProperty("--ag-fg", t.colors.fg);
  root.style.setProperty("--ag-fg-muted", t.colors.muted);
  root.style.setProperty("--ag-accent", t.colors.accent);
  localStorage.setItem("ag-theme", themeId);
}

export function applySettings(s: UserSettings) {
  const root = document.documentElement;
  const uiFont = s.ui_font ?? DEFAULT_UI_FONT;
  const monoFont = s.mono_font ?? DEFAULT_MONO_FONT;
  const fontSize = s.font_size ?? DEFAULT_FONT_SIZE;
  root.style.setProperty("--ag-font-ui", uiFont);
  root.style.setProperty("--ag-font-mono", monoFont);
  // Expose the base UI size as both an explicit var (consumed by panels
  // that opt-in via em-relative sizing) and as the root font-size so
  // any rem-based styles also pick it up.
  root.style.setProperty("--ag-font-size", `${fontSize}px`);
  root.style.fontSize = `${fontSize}px`;
  if (s.theme) {
    if (state.themes.length > 0) setTheme(s.theme);
    else setState("themeId", s.theme);
  }
}

export async function saveSettings(patch: UserSettings) {
  const merged: UserSettings = { ...state.settings, ...patch };
  setState("settings", merged);
  applySettings(merged);
  try {
    await api.saveSettings(merged);
  } catch (e) {
    if (e instanceof Error) setState("loadError", e.message);
  }
}

export const FONT_FAMILY_PRESETS: { label: string; value: string }[] = [
  { label: "Inter (default)", value: DEFAULT_UI_FONT },
  {
    label: "System",
    value: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  { label: "IBM Plex Sans", value: '"IBM Plex Sans", Inter, system-ui, sans-serif' },
  { label: "Source Sans 3", value: '"Source Sans 3", Inter, system-ui, sans-serif' },
];

export const MONO_FAMILY_PRESETS: { label: string; value: string }[] = [
  { label: "JetBrains Mono (default)", value: DEFAULT_MONO_FONT },
  {
    label: "Fira Code",
    value: '"Fira Code", "JetBrains Mono", ui-monospace, Menlo, monospace',
  },
  { label: "IBM Plex Mono", value: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", ui-monospace, Menlo, monospace' },
];

export const FONT_SIZES: number[] = [12, 13, 14, 15, 16, 17, 18];

export function selectChat(id: string) {
  setActiveChat(id);
}

export { DEFAULT_FONT_SIZE, DEFAULT_UI_FONT, DEFAULT_MONO_FONT };
