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
import { api, type Project, type Theme, type UserSettings, type Worktree } from "../api/client";

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

// ---- Unified tab model ------------------------------------------------
//
// Every item the user works with in the main area is a "tab" in a
// flat strip. No grouping by type — chats, terminals, and file
// editors live side by side in the order the user opened them.
// Notes are NOT a tab — they live in the always-visible right
// sidebar.

/** Discriminated union for the different tab types. Each variant
 *  carries the minimal state the tab strip needs to render its
 *  chip (icon + label) + the content pane needs to mount. */
export type UnifiedTab =
  | { kind: "chat"; id: string; title: string; draft?: string }
  | { kind: "terminal"; id: string; cwd: string; label: string }
  | { kind: "editor"; id: string; path: string; label: string };

/** Legacy chat tab — kept for migration from the old layout blobs.
 *  New code should use `UnifiedTab` exclusively. */
export interface ChatTab {
  id: string;
  title: string;
  draft?: string;
}

/** Workspace scope: unified tab state. Owned by a scope key
 *  (project, or worktree-of-project). */
export interface Scope {
  /** Flat list of open tabs in display order. Mixed types. */
  tabs: UnifiedTab[];
  /** ID of the currently-focused tab, or null when the strip is
   *  empty. Must match one of `tabs[].id`. */
  activeTab: string | null;
  /** Whether the right sidebar (Notes + Queue) is visible. */
  sidebarOpen: boolean;

  // ---- Legacy fields kept for migration + backward compat ----
  // The layout write-through still serialises these so an older FE
  // reading the same blob doesn't crash. New code ignores them and
  // reads from `tabs` + `activeTab` instead. They'll be dropped in
  // a future cleanup pass once every user has migrated.
  /** @deprecated Use tabs + activeTab. */
  activePane?: PaneId;
  /** @deprecated Use tabs filtered by kind=editor. */
  activeEditor?: string | null;
  /** @deprecated Use tabs filtered by kind=terminal. */
  terminals?: TerminalTab[];
  /** @deprecated Use tabs filtered by kind=terminal + activeTab. */
  activeTerminal?: string | null;
  /** @deprecated Use tabs filtered by kind=chat. */
  chats?: ChatTab[];
  /** @deprecated Use activeTab. */
  activeChat?: string | null;
  /** @deprecated Bootstrap tracking for chats. */
  chatsHydrated?: boolean;
}

function freshScope(): Scope {
  return {
    tabs: [],
    activeTab: null,
    sidebarOpen: true,
    chatsHydrated: false,
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

// ---- Unified tab helpers -----------------------------------------------
//
// The new model: a flat `tabs: UnifiedTab[]` + `activeTab: string | null`.
// Every chat, terminal, and file editor is a tab. Notes are NOT tabs —
// they live in the always-visible right sidebar.

/** The currently active tab object, or undefined. */
export function activeTab(): UnifiedTab | undefined {
  const scope = currentScope();
  if (!scope?.activeTab) return undefined;
  return scope.tabs.find((t) => t.id === scope.activeTab);
}

/** What "kind" of content the active tab shows. */
export function activeTabKind(): UnifiedTab["kind"] | null {
  return activeTab()?.kind ?? null;
}

/** Add a tab to the current scope. Activates it. Returns ok/reason
 *  for consistency with the old API shape. */
export function addTab(tab: UnifiedTab): { ok: boolean; reason?: string } {
  const key = currentScopeKey();
  if (!key) return { ok: false, reason: "no project selected" };
  ensureScope(key);
  setState(
    "byScope",
    key,
    produce((s) => {
      if (s.tabs.find((t) => t.id === tab.id)) {
        // Already open — just activate.
        s.activeTab = tab.id;
        return;
      }
      s.tabs.push(tab);
      s.activeTab = tab.id;
    }),
  );
  scheduleScopeLayoutWrite(key);
  return { ok: true };
}

/** Close a tab by id. Activates a neighbour if the closed tab was
 *  active. Returns whether anything was removed. */
export function closeTab(tabId: string): boolean {
  const key = currentScopeKey();
  if (!key) return false;
  let removed = false;
  setState(
    "byScope",
    key,
    produce((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      s.tabs.splice(idx, 1);
      removed = true;
      if (s.activeTab === tabId) {
        s.activeTab = s.tabs[Math.min(idx, s.tabs.length - 1)]?.id ?? null;
      }
    }),
  );
  if (removed) scheduleScopeLayoutWrite(key);
  return removed;
}

/** Switch focus to an existing tab. */
export function setActiveTab(tabId: string) {
  const key = currentScopeKey();
  if (!key) return;
  setState("byScope", key, "activeTab", tabId);
  scheduleScopeLayoutWrite(key);
}

/** Toggle the right sidebar (Notes + Queue). */
export function toggleSidebar() {
  const key = currentScopeKey();
  if (!key) return;
  ensureScope(key);
  setState(
    "byScope",
    key,
    produce((s) => {
      s.sidebarOpen = !s.sidebarOpen;
    }),
  );
  scheduleScopeLayoutWrite(key);
}

/** Whether the right sidebar is open. */
export function isSidebarOpen(): boolean {
  return currentScope()?.sidebarOpen ?? true;
}

// ---- Backward-compat shims (delegate to unified tabs) -----------------
//
// These keep existing callers (ChatPane, TerminalPane, LeftRail, …)
// working during the incremental migration. They'll be inlined or
// deleted once every caller switches to addTab/closeTab/setActiveTab.

/** @deprecated Use activeTab() filtered by kind. */
export function activePane(): PaneId {
  const tab = activeTab();
  if (!tab) return "chat";
  switch (tab.kind) {
    case "chat":
      return "chat";
    case "terminal":
      return "terminal";
    case "editor":
      return "editor";
  }
}

/** @deprecated Use addTab + setActiveTab. */
export function setActivePane(pane: PaneId) {
  // Legacy: pane switcher is gone. This is a no-op now; callers
  // that used it to switch panes should use setActiveTab instead.
  void pane;
}

// ---- editor (opens as a tab now) ----------------------------------------

export function selectFile(path: string) {
  const label = path.split("/").pop() ?? path;
  addTab({ kind: "editor", id: `file:${path}`, path, label });
}

export function selectedFilePath(): string | null {
  const tab = activeTab();
  if (tab?.kind === "editor") return tab.path;
  return null;
}

export function selectedChatId(): string | null {
  const tab = activeTab();
  if (tab?.kind === "chat") return tab.id;
  return null;
}

// ---- chat tab shims (delegate to unified tabs) -------------------------

export function addChatTab(chat: ChatTab): { ok: boolean; reason?: string } {
  return addTab({
    kind: "chat",
    id: chat.id,
    title: chat.title,
    ...(chat.draft ? { draft: chat.draft } : {}),
  });
}

export function setScopeChats(chats: ChatTab[]) {
  const key = currentScopeKey();
  if (!key) return;
  ensureScope(key);
  setState(
    "byScope",
    key,
    produce((s) => {
      // Remove chat tabs not in the new list.
      const chatIds = new Set(chats.map((c) => c.id));
      s.tabs = s.tabs.filter((t) => t.kind !== "chat" || chatIds.has(t.id));
      // Add any new chats not already in tabs.
      const existing = new Set(s.tabs.map((t) => t.id));
      for (const c of chats) {
        if (!existing.has(c.id)) {
          s.tabs.push({
            kind: "chat",
            id: c.id,
            title: c.title,
            ...(c.draft ? { draft: c.draft } : {}),
          });
        } else {
          // Update title + preserve draft from tab.
          const tab = s.tabs.find((t) => t.id === c.id);
          if (tab && tab.kind === "chat") {
            tab.title = c.title;
          }
        }
      }
      s.chatsHydrated = true;
      // If active tab was a removed chat, pick the first chat or null.
      if (s.activeTab && !s.tabs.find((t) => t.id === s.activeTab)) {
        const firstChat = s.tabs.find((t) => t.kind === "chat");
        s.activeTab = firstChat?.id ?? s.tabs[0]?.id ?? null;
      }
    }),
  );
  scheduleScopeLayoutWrite(key);
}

export function closeChatTab(chatId: string) {
  closeTab(chatId);
}

export function setActiveChat(chatId: string) {
  setActiveTab(chatId);
}

/** Persist an in-flight composer draft for `chatId`. */
export function setChatDraft(chatId: string, draft: string) {
  const key = currentScopeKey();
  if (!key) return;
  setState(
    "byScope",
    key,
    produce((s) => {
      const tab = s.tabs.find((t) => t.kind === "chat" && t.id === chatId);
      if (!tab || tab.kind !== "chat") return;
      if (draft.length === 0) {
        delete tab.draft;
      } else {
        tab.draft = draft;
      }
    }),
  );
  scheduleScopeLayoutWrite(key);
}

/** Read the persisted draft for `chatId`, or `""` if none. */
export function getChatDraft(chatId: string): string {
  const key = currentScopeKey();
  if (!key) return "";
  const tab = state.byScope[key]?.tabs.find((t) => t.kind === "chat" && t.id === chatId);
  return (tab as { draft?: string } | undefined)?.draft ?? "";
}

// ---- terminal tab shims (delegate to unified tabs) --------------------

export function addTerminalTab(t: TerminalTab): { ok: boolean; reason?: string } {
  return addTab({
    kind: "terminal",
    id: t.id,
    cwd: t.cwd,
    label: t.label,
  });
}

export function closeTerminalTab(id: string) {
  closeTab(id);
}

export function setActiveTerminal(id: string) {
  setActiveTab(id);
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
  // Layout hydration runs AFTER projects load so we can map the
  // BE's per-scope blobs into our `byScope` cache without
  // overwriting any defaults set by `selectProject`.
  await hydrateLayoutFromBackend();
  setState("ready", true);
}

/** Pull the latest layout snapshot from the BE and merge it into
 *  the store. Each per-scope blob becomes (or overwrites) the
 *  matching `state.byScope[key]` entry; missing scopes stay at
 *  their freshScope defaults so a never-seen project still works.
 *
 *  The global blob isn't wired into anything user-visible yet
 *  (we'll add it as we move rail-width / show-files / etc.
 *  off localStorage). The endpoint is already there + tested. */
async function hydrateLayoutFromBackend() {
  try {
    const snap = await api.getLayout();
    for (const s of snap.scopes) {
      const key = s.worktree_id ? `${s.project_id}::${s.worktree_id}` : s.project_id;
      const incoming = s.blob as Partial<Scope> & {
        chats?: ChatTab[];
        terminals?: TerminalTab[];
        activeChat?: string | null;
        activeTerminal?: string | null;
        activeEditor?: string | null;
        activePane?: PaneId;
      };
      const base = { ...freshScope(), ...incoming };

      // ---- Migration: old layout → unified tabs ----
      // Old blobs have `chats[]` + `terminals[]` + `activeEditor`
      // + `activeChat` + `activeTerminal` as separate fields.
      // If `tabs` is missing or empty AND the old fields have data,
      // migrate into the unified model.
      if (
        (!base.tabs || base.tabs.length === 0) &&
        ((incoming.chats && incoming.chats.length > 0) ||
          (incoming.terminals && incoming.terminals.length > 0) ||
          incoming.activeEditor)
      ) {
        const migrated: UnifiedTab[] = [];
        // Chats first.
        for (const c of incoming.chats ?? []) {
          migrated.push({
            kind: "chat",
            id: c.id,
            title: c.title,
            ...(c.draft ? { draft: c.draft } : {}),
          });
        }
        // Terminals.
        for (const t of incoming.terminals ?? []) {
          migrated.push({
            kind: "terminal",
            id: t.id,
            cwd: t.cwd,
            label: t.label,
          });
        }
        // Editor (at most one in the old model).
        if (incoming.activeEditor) {
          const label = incoming.activeEditor.split("/").pop() ?? incoming.activeEditor;
          migrated.push({
            kind: "editor",
            id: `file:${incoming.activeEditor}`,
            path: incoming.activeEditor,
            label,
          });
        }
        base.tabs = migrated;
        // Resolve activeTab from the old active* fields.
        if (incoming.activeChat) {
          base.activeTab = incoming.activeChat;
        } else if (incoming.activeTerminal) {
          base.activeTab = incoming.activeTerminal;
        } else if (incoming.activeEditor) {
          base.activeTab = `file:${incoming.activeEditor}`;
        } else {
          base.activeTab = migrated[0]?.id ?? null;
        }
      }
      setState("byScope", key, base);
    }
  } catch {
    // Layout is best-effort — running without it just means a
    // fresh start on this device.
  }
}

/** Persist a single scope's snapshot to the BE. Throttled by
 *  `scheduleScopeLayoutWrite` below — call THAT, not this. */
async function writeScopeLayout(key: string) {
  const [projectId, worktreeId = ""] = key.split("::");
  if (!projectId) return;
  const scope = state.byScope[key];
  if (!scope) return;
  try {
    await api.putScopeLayout(projectId, worktreeId, scope);
  } catch {
    // Best-effort — a transient BE error doesn't break the UI;
    // the next mutation will retry.
  }
}

/** Debounced per-scope layout writer. The composer + tabs +
 *  pane switcher all mutate `byScope` rapidly; coalescing the
 *  writes keeps the BE quiet (one PUT per scope per ~400 ms)
 *  while still feeling instant.
 *
 *  Call this whenever you mutate `state.byScope[key]`. */
const scopeWriteTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
export function scheduleScopeLayoutWrite(key: string) {
  const existing = scopeWriteTimers[key];
  if (existing) clearTimeout(existing);
  scopeWriteTimers[key] = setTimeout(() => {
    scopeWriteTimers[key] = undefined;
    void writeScopeLayout(key);
  }, 400);
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

/** Dynamically inject a Google Fonts stylesheet so the user's
 *  chosen font renders without requiring a pre-bundled web font.
 *  Idempotent: calling twice with the same family is a no-op. */
const loadedFonts = new Set<string>();
function loadGoogleFont(family: string) {
  // Extract the first quoted font name from the CSS stack.
  const match = family.match(/"([^"]+)"/);
  const name = match ? match[1] : family.split(",")[0]!.trim();
  if (!name || loadedFonts.has(name)) return;
  loadedFonts.add(name);
  // Skip system / generic families.
  const skip = [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "sans-serif",
    "ui-monospace",
    "SFMono-Regular",
    "Menlo",
    "Consolas",
    "monospace",
    "Inter",
    "JetBrains Mono",
  ];
  if (skip.includes(name)) return;
  const encoded = encodeURIComponent(name);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@300;400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

export function applySettings(s: UserSettings) {
  const root = document.documentElement;
  const uiFont = s.ui_font ?? DEFAULT_UI_FONT;
  const monoFont = s.mono_font ?? DEFAULT_MONO_FONT;
  const fontSize = s.font_size ?? DEFAULT_FONT_SIZE;
  root.style.setProperty("--ag-font-ui", uiFont);
  root.style.setProperty("--ag-font-mono", monoFont);
  loadGoogleFont(uiFont);
  loadGoogleFont(monoFont);
  // Expose the base UI size as both an explicit var (consumed by panels
  // that opt-in via em-relative sizing) and as the root font-size so
  // any rem-based styles also pick it up.
  root.style.setProperty("--ag-font-size", `${fontSize}px`);
  // Scale the entire UI proportionally. Components use hardcoded
  // Tailwind pixel sizes (text-[13px], text-[12px], etc.) that
  // don't respond to root font-size. CSS `zoom` on the root
  // scales EVERYTHING including those px values, giving the user
  // a true "make everything bigger/smaller" knob without
  // rewriting every size class to em/rem.
  const baseSize = 15; // matches DEFAULT_FONT_SIZE
  const zoom = fontSize / baseSize;
  root.style.zoom = `${zoom}`;
  // Expose the inverse so position:fixed overlays that the Tiptap
  // drag-handle plugin places using viewport-pixel coords can cancel
  // out the root zoom (otherwise their left/top get multiplied by it).
  root.style.setProperty("--ag-zoom-inv", `${baseSize / fontSize}`);
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

// Popular free developer UI fonts. Each is available from Google
// Fonts (loaded on demand via the `loadGoogleFont` helper below)
// or commonly pre-installed on developer machines. The fallback
// chain ensures a clean render even if the font hasn't loaded yet.
export const FONT_FAMILY_PRESETS: { label: string; value: string }[] = [
  { label: "Inter (default)", value: DEFAULT_UI_FONT },
  {
    label: "System",
    value: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  { label: "Geist", value: '"Geist", Inter, system-ui, sans-serif' },
  { label: "IBM Plex Sans", value: '"IBM Plex Sans", Inter, system-ui, sans-serif' },
  { label: "Nunito Sans", value: '"Nunito Sans", Inter, system-ui, sans-serif' },
  { label: "Open Sans", value: '"Open Sans", Inter, system-ui, sans-serif' },
  { label: "Outfit", value: '"Outfit", Inter, system-ui, sans-serif' },
  { label: "Plus Jakarta Sans", value: '"Plus Jakarta Sans", Inter, system-ui, sans-serif' },
  { label: "Poppins", value: '"Poppins", Inter, system-ui, sans-serif' },
  { label: "Roboto", value: '"Roboto", Inter, system-ui, sans-serif' },
  { label: "Source Sans 3", value: '"Source Sans 3", Inter, system-ui, sans-serif' },
  { label: "Space Grotesk", value: '"Space Grotesk", Inter, system-ui, sans-serif' },
  { label: "Work Sans", value: '"Work Sans", Inter, system-ui, sans-serif' },
];

// Popular free monospace / code fonts.
export const MONO_FAMILY_PRESETS: { label: string; value: string }[] = [
  { label: "JetBrains Mono (default)", value: DEFAULT_MONO_FONT },
  { label: "Cascadia Code", value: '"Cascadia Code", ui-monospace, Menlo, monospace' },
  { label: "Fira Code", value: '"Fira Code", ui-monospace, Menlo, monospace' },
  { label: "Geist Mono", value: '"Geist Mono", ui-monospace, Menlo, monospace' },
  { label: "IBM Plex Mono", value: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
  { label: "Inconsolata", value: '"Inconsolata", ui-monospace, Menlo, monospace' },
  { label: "Iosevka", value: '"Iosevka", ui-monospace, Menlo, monospace' },
  { label: "Monaspace Neon", value: '"Monaspace Neon", ui-monospace, Menlo, monospace' },
  { label: "Roboto Mono", value: '"Roboto Mono", ui-monospace, Menlo, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", ui-monospace, Menlo, monospace' },
  { label: "Ubuntu Mono", value: '"Ubuntu Mono", ui-monospace, Menlo, monospace' },
  { label: "Victor Mono", value: '"Victor Mono", ui-monospace, Menlo, monospace' },
];

export const FONT_SIZES: number[] = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24];

export function selectChat(id: string) {
  setActiveChat(id);
}

export { DEFAULT_FONT_SIZE, DEFAULT_UI_FONT, DEFAULT_MONO_FONT };
