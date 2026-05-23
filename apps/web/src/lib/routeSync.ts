import { createEffect } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import {
  currentWorktreeId,
  selectFile,
  selectProject,
  selectWorktree,
  selectedChatId,
  selectedFilePath,
  setActiveChat,
  setActivePane,
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

  // --- URL -> store ---
  //
  // Reactively read `location.pathname` + search params and reflect
  // them into the store. Runs ONLY after `state.ready` so we don't
  // overwrite the freshly-bootstrapped selection with the empty
  // URL (the FE writes through to the URL only when ready is true
  // too, so the initial deep-linked URL is what we apply on first
  // visit).
  createEffect(() => {
    if (!state.ready) return;
    const path = location.pathname;
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
      setActiveChat(chat);
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
    const pane = state.byScope[currentScopeKeyOrEmpty()]?.activePane ?? "chat";
    const chat = selectedChatId();
    const file = selectedFilePath();

    const url = buildUrl(pid, wid, pane, chat, file);
    if (url === location.pathname + location.search) return;

    // Push a history entry only when the SCOPE changes; pane/chat/
    // file swaps stay on the same entry to keep the back button
    // useful (one click escapes the project, not five panes deep).
    const scopeChanged = pid !== lastProject || wid !== lastWorktree;
    navigate(url, { replace: !scopeChanged });
    lastProject = pid;
    lastWorktree = wid;
  });
}

function isPaneId(s: string): s is PaneId {
  return ["chat", "editor", "terminal", "notes"].includes(s);
}

function currentScopeKeyOrEmpty(): string {
  const pid = state.selectedProjectId;
  if (!pid) return "";
  const wid = currentWorktreeId();
  return wid ? `${pid}::${wid}` : pid;
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
