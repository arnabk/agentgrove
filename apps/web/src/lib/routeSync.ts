import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import {
  currentScope,
  currentScopeKey,
  currentWorktreeId,
  ensureChatTab,
  selectFile,
  selectProject,
  selectWorktree,
  selectedChatId,
  selectedFilePath,
  setActiveChat,
  setActivePane,
  setRouteError,
  state,
} from "../stores/app";
import type { PaneId } from "../stores/app";

/**
 * Bidirectional URL <-> store sync for the active workspace state.
 *
 * URL shape:
 *
 *   /                                         no scope (landing)
 *   /p/:projectId                             project root scope
 *   /p/:projectId/w/:worktreeId               worktree-of-project scope
 *   ?pane=chat|editor|terminal|notes          active pane
 *   ?chat=:chatId                             active chat tab
 *   ?file=<encoded-absolute-path>             active editor file
 *
 * Goals:
 *   - Refreshing the page restores the exact scope + pane + chat +
 *     file the user was on.
 *   - Copy-pasting a URL into another tab opens the same view.
 *   - Back/forward buttons traverse the user's navigation window.history
 *     across scope switches.
 *
 * Implementation notes:
 *   - The store remains the source of truth at runtime. We mirror
 *     into the URL via the History API so we never trigger Solid
 *     Router's "too many redirects" guard, which fires when a route
 *     effect calls `navigate` during route resolution.
 *   - URL -> store applies only when the URL changes from outside
 *     (initial load or popstate). Our own writes record the URL in
 *     `selfWrittenUrl` so we don't bounce a write back into the store.
 *   - We don't track `byScope` mutations like scroll position or
 *     drafts here — those live in the layout blob and persist via
 *     their own machinery.
 */
let installed = false;

export function installRouteSync() {
  if (installed) return;
  installed = true;

  // The exact URL the store->URL effect is about to write. The
  // URL->store path uses this to ignore its own echo.
  let selfWrittenUrl: string | null = null;

  // Gate: don't let the store->URL effect write anything until the
  // initial URL has been applied to the store. Otherwise the hydrated
  // active tab (from the BE layout blob) overwrites ?chat= on page load
  // before routeSync has a chance to open the requested chat.
  const [initialUrlApplied, setInitialUrlApplied] = createSignal(false);

  // --- store -> URL ---
  //
  // Compose the canonical URL from current state and write it through
  // the History API. We use replaceState by default to avoid a window.history
  // entry per click; project/worktree changes pushState so back/forward
  // jumps between scopes.
  let lastProject: string | null = null;
  let lastWorktree: string | null = null;
  createEffect(() => {
    if (!state.ready || !initialUrlApplied()) return;
    const pid = state.selectedProjectId;
    const wid = currentWorktreeId();
    const pane = state.byScope[currentScopeKey() ?? ""]?.activePane ?? "chat";
    const chat = selectedChatId();
    const file = selectedFilePath();

    const url = buildUrl(pid, wid, pane, chat, file);
    // Read the browser URL untracked so this effect only responds to
    // store changes, not to its own writes.
    const here = untrack(() => window.location.pathname + window.location.search);
    if (url === here) return;

    const scopeChanged = pid !== lastProject || wid !== lastWorktree;
    selfWrittenUrl = url;
    if (scopeChanged) {
      window.history.pushState({}, "", url);
    } else {
      window.history.replaceState({}, "", url);
    }
    lastProject = pid;
    lastWorktree = wid;
  });

  // --- URL -> store ---
  //
  // Apply the current browser URL to the store. Runs once after the
  // store is ready, and again on every popstate (back/forward).
  let lastValidatedScope = "";

  function applyUrlToStore() {
    if (!state.ready) return;
    const path = window.location.pathname;
    const here = path + window.location.search;
    if (here === selfWrittenUrl) {
      selfWrittenUrl = null;
      return;
    }
    selfWrittenUrl = null;

    const segments = path.split("/").filter(Boolean);

    // Path: /p/<pid>[/w/<wid>]
    let targetProject: string | null = null;
    let targetWorktree: string | null = null;
    if (segments[0] === "p" && segments[1]) {
      targetProject = segments[1]!;
      if (segments[2] === "w" && segments[3]) {
        targetWorktree = segments[3]!;
      }
    }

    const scopeSig = `${targetProject ?? ""}::${targetWorktree ?? ""}`;
    if (scopeSig !== lastValidatedScope) {
      lastValidatedScope = scopeSig;

      // Guard against a project/worktree that no longer exists.
      if (targetProject && state.projects.length > 0 && !hasProject(targetProject)) {
        setRouteError("That project no longer exists — taking you back.");
        const fallback =
          (state.selectedProjectId &&
            hasProject(state.selectedProjectId) &&
            state.selectedProjectId) ||
          state.projects[0]?.id ||
          null;
        const fallbackUrl = fallback ? `/p/${fallback}` : "/";
        window.history.replaceState({}, "", fallbackUrl);
        targetProject = fallback;
        targetWorktree = null;
      }

      if (targetProject && targetWorktree && hasProject(targetProject)) {
        const wts = state.worktrees[targetProject];
        if (wts && wts.length > 0 && !wts.some((w) => w.id === targetWorktree)) {
          setRouteError("That worktree no longer exists — showing the project root.");
          window.history.replaceState({}, "", `/p/${targetProject}`);
          targetWorktree = null;
        }
      }
    }

    if (targetProject && state.selectedProjectId !== targetProject) {
      selectProject(targetProject);
    }
    if (targetWorktree !== currentWorktreeId() && targetProject) {
      selectWorktree(targetProject, targetWorktree);
    }

    const search = new URLSearchParams(window.location.search);
    const pane = search.get("pane") as PaneId | null;
    if (pane && isPaneId(pane)) {
      setActivePane(pane);
    }
    const chat = search.get("chat");
    if (chat && selectedChatId() !== chat) {
      const scope = currentScope();
      const inTabs = scope?.tabs.some((t) => t.id === chat);
      if (inTabs) {
        setActiveChat(chat);
      } else {
        ensureChatTab(chat);
      }
    }
    const file = search.get("file");
    if (file && file !== selectedFilePath()) {
      selectFile(decodeURIComponent(file));
    }
  }

  // Apply the initial URL once the store is ready.
  createEffect(() => {
    if (!state.ready) return;
    applyUrlToStore();
    setInitialUrlApplied(true);
  });

  // Back/forward updates the browser URL; apply it to the store.
  const onPop = () => applyUrlToStore();
  window.addEventListener("popstate", onPop);
  onCleanup(() => window.removeEventListener("popstate", onPop));
}

function isPaneId(s: string): s is PaneId {
  return ["chat", "editor", "terminal", "notes"].includes(s);
}

function hasProject(id: string): boolean {
  return state.projects.some((p) => p.id === id);
}

function buildUrl(
  pid: string | null,
  wid: string | null,
  pane: PaneId,
  chat: string | null,
  file: string | null,
): string {
  if (!pid) return "/";
  let path = `/p/${pid}`;
  if (wid) path += `/w/${wid}`;
  const params: string[] = [];
  if (pane && pane !== "chat") params.push(`pane=${pane}`);
  if (chat) params.push(`chat=${chat}`);
  if (file) params.push(`file=${encodeURIComponent(file)}`);
  return params.length > 0 ? `${path}?${params.join("&")}` : path;
}
