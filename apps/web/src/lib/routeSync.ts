import { createEffect } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import {
  currentScope,
  currentScopeKey,
  currentWorktreeId,
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
 *   - Back/forward buttons traverse the user's navigation history
 *     across scope switches.
 *
 * Implementation notes:
 *   - The store remains the source of truth at runtime. We mirror
 *     into the URL via `navigate(..., { replace: true })` so the
 *     history stack stays clean (no entry per keystroke). We DO
 *     push (replace=false) when the project / worktree changes
 *     so back/forward actually jumps between scopes.
 *   - URL -> store applies only when the store doesn't already
 *     reflect the URL: this avoids the feedback loop where our
 *     own write triggers a read which re-writes.
 *   - We don't track `byScope` mutations like scroll position or
 *     drafts here — those live in the layout blob and persist via
 *     their own machinery.
 */
export function installRouteSync() {
  const location = useLocation();
  const navigate = useNavigate();

  // The exact `pathname + search` of the last URL the store->URL effect
  // wrote. The URL->store effect uses this to ignore its own echo: when
  // the user activates a tab, the store changes, store->URL writes the
  // new ?chat, and that location change must NOT bounce back through
  // URL->store and re-apply the *previous* ?chat (which reverted tab
  // activation — new chats appeared to "not open"). URL changes from
  // the browser back/forward buttons won't match this value, so genuine
  // navigations still flow through.
  let selfWrittenUrl: string | null = null;

  // --- URL -> store ---
  //
  // Reactively read `location.pathname` + search params and reflect
  // them into the store. Runs ONLY after `state.ready` so we don't
  // overwrite the freshly-bootstrapped selection with the empty
  // URL (the FE writes through to the URL only when ready is true
  // too, so the initial deep-linked URL is what we apply on first
  // visit).
  // Remembers the last scope segment (/p/<pid>[/w/<wid>]) we ran the
  // existence check against, so validation+redirect happens once per
  // scope change rather than on every effect re-run. Without this the
  // guard re-fired whenever ?chat / ?pane / ?file changed (or when
  // state.projects/worktrees updated reactively), and a transient
  // mismatch produced a navigate → URL change → re-run → navigate loop
  // ("Too many redirects").
  let lastValidatedScope = "";
  createEffect(() => {
    if (!state.ready) return;
    const path = location.pathname;
    const here = path + location.search;
    // Ignore our own store->URL write — applying it back into the store
    // is a no-op at best and a revert race at worst (see selfWrittenUrl).
    if (here === selfWrittenUrl) return;
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
    // Only run the (potentially redirecting) existence validation when
    // the scope segment of the path actually changed. ?chat/?pane/?file
    // changes and unrelated store updates must not re-trigger it.
    if (scopeSig !== lastValidatedScope) {
      lastValidatedScope = scopeSig;

      // Guard against navigating (e.g. via browser back/forward) to a
      // project that no longer exists — a deleted project or a stale
      // history entry from a previous BE database. Selecting a phantom
      // id leaves the app in a broken, empty state. Instead, surface an
      // error and redirect to a valid scope. Only do this once projects
      // have actually loaded, so we don't redirect during the initial
      // hydration window when the list is briefly empty.
      if (targetProject && state.projects.length > 0 && !hasProject(targetProject)) {
        setRouteError("That project no longer exists — taking you back.");
        const fallback =
          (state.selectedProjectId &&
            hasProject(state.selectedProjectId) &&
            state.selectedProjectId) ||
          state.projects[0]?.id ||
          null;
        navigate(fallback ? `/p/${fallback}` : "/", { replace: true });
        return;
      }

      // Validate the worktree too: an unknown worktree id for a valid
      // project should fall back to the project root. worktrees may not
      // be loaded yet, so only reject when we have the list and the id
      // is genuinely absent from it.
      if (targetProject && targetWorktree && hasProject(targetProject)) {
        const wts = state.worktrees[targetProject];
        if (wts && wts.length > 0 && !wts.some((w) => w.id === targetWorktree)) {
          setRouteError("That worktree no longer exists — showing the project root.");
          navigate(`/p/${targetProject}`, { replace: true });
          return;
        }
      }
    }

    if (targetProject && state.selectedProjectId !== targetProject) {
      selectProject(targetProject);
    }
    if (targetWorktree !== currentWorktreeId() && targetProject) {
      selectWorktree(targetProject, targetWorktree);
    }

    const search = new URLSearchParams(location.search);
    const pane = search.get("pane") as PaneId | null;
    if (pane && isPaneId(pane)) {
      // setActivePane is per-scope so order matters: scope set
      // above first, then pane.
      setActivePane(pane);
    }
    const chat = search.get("chat");
    if (chat && selectedChatId() !== chat) {
      // Only restore if the chat is still in the current scope's
      // tab list. Without this check, closing the last tab →
      // activeChat=null → route sync sees ?chat=<stale-id> →
      // re-instates the closed chat as active, resurrecting it.
      const scope = currentScope();
      const inTabs = scope?.tabs.some((t) => t.id === chat);
      if (inTabs) {
        setActiveChat(chat);
      }
    }
    const file = search.get("file");
    if (file && file !== selectedFilePath()) {
      selectFile(decodeURIComponent(file));
    }
  });

  // --- store -> URL ---
  //
  // Compose the canonical URL from current state and write it
  // through `navigate({ replace: true })`. We use replace by
  // default to avoid a history entry per click; project +
  // worktree changes push instead so back/forward jumps between
  // scopes the way the user expects.
  let lastProject: string | null = null;
  let lastWorktree: string | null = null;
  createEffect(() => {
    if (!state.ready) return;
    const pid = state.selectedProjectId;
    const wid = currentWorktreeId();
    const pane = state.byScope[currentScopeKey() ?? ""]?.activePane ?? "chat";
    const chat = selectedChatId();
    const file = selectedFilePath();

    const url = buildUrl(pid, wid, pane, chat, file);
    if (url === location.pathname + location.search) return;

    // Push a history entry only when the SCOPE changes; pane/chat/
    // file swaps stay on the same entry to keep the back button
    // useful (one click escapes the project, not five panes deep).
    const scopeChanged = pid !== lastProject || wid !== lastWorktree;
    // Record the URL we're about to write so the URL->store effect can
    // recognise (and ignore) its own echo.
    selfWrittenUrl = url;
    navigate(url, { replace: !scopeChanged });
    lastProject = pid;
    lastWorktree = wid;
  });
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
