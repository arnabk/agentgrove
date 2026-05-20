import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api, type TreeEntry } from "../api/client";
import {
  addChatTab,
  currentWorktreeId,
  refreshProjects,
  refreshWorktreesForProject,
  selectFile,
  selectWorktree,
  selectedFilePath,
  setChangesScope,
  state,
} from "../stores/app";
import { confirm } from "./dialog";
import FolderPicker from "./FolderPicker";
import WorktreeDialog from "./WorktreeDialog";
import WorktreeHistoryDialog from "./WorktreeHistoryDialog";

/** Persisted set of expanded project ids — so multiple folders can stay
 *  open in the left rail at once. */
const EXP_LS_KEY = "ag-expanded-projects";

function loadExpanded(): Record<string, true> {
  try {
    const raw = localStorage.getItem(EXP_LS_KEY);
    if (!raw) return {};
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return {};
    const out: Record<string, true> = {};
    for (const v of arr) if (typeof v === "string") out[v] = true;
    return out;
  } catch {
    return {};
  }
}

function saveExpanded(rec: Record<string, true>) {
  try {
    localStorage.setItem(EXP_LS_KEY, JSON.stringify(Object.keys(rec)));
  } catch {
    // ignore quota errors
  }
}

const RAIL_MIN_PX = 200;
const RAIL_MAX_PX = 480;
const RAIL_DEFAULT_PX = 260;
const RAIL_LS_KEY = "ag-rail-w";

/**
 * Left navigation: projects only.
 *
 * Worktrees, chats, terminals, notes, and queue all live inside the main
 * area now and are scoped to the selected project. The rail's only job is
 * to switch between projects and add new ones.
 *
 * Width is user-resizable via the right edge handle. Width persists to
 * localStorage and is clamped to [RAIL_MIN_PX, RAIL_MAX_PX].
 */
export default function LeftRail() {
  const [picking, setPicking] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  // Active project id we are creating a worktree for; null when dialog closed.
  const [wtFor, setWtFor] = createSignal<string | null>(null);
  // Active project id whose history dialog is open; null when closed.
  const [historyFor, setHistoryFor] = createSignal<string | null>(null);

  // Per-project expansion. Independent of selection — many can be open.
  const [expanded, setExpanded] = createStore<Record<string, true>>(loadExpanded());
  const isExpanded = (id: string) => Boolean(expanded[id]);
  function toggleExpanded(id: string) {
    setExpanded(
      produce((e) => {
        if (e[id]) delete e[id];
        else e[id] = true;
      }),
    );
    saveExpanded(expanded);
  }
  function expand(id: string) {
    if (!expanded[id]) {
      setExpanded(id, true);
      saveExpanded(expanded);
    }
  }

  async function deleteWorktree(projectId: string, wtId: string, ev: MouseEvent) {
    ev.stopPropagation();
    const ok = await confirm({
      title: "Remove worktree",
      body: "Remove this worktree from disk and AgentGrove? The branch itself is not deleted.",
      confirmLabel: "Remove",
      danger: true,
      testId: "confirm-remove-worktree",
    });
    if (!ok) return;
    try {
      await api.deleteWorktree(projectId, wtId);
      // If the user was scoped into the worktree we just deleted, fall
      // back to the project root scope.
      if (
        state.selectedProjectId === projectId &&
        state.selectedWorktreeByProject[projectId] === wtId
      ) {
        selectWorktree(projectId, null);
      }
      await refreshWorktreesForProject(projectId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Create a new chat scoped to (projectId, optional worktreeId). The new
   *  chat becomes the active tab in the Chat pane and the active scope
   *  flips to match — so the new chat is visible immediately. */
  async function newChat(
    projectId: string,
    worktreeId: string | null,
    parentName: string,
  ) {
    setErr(null);
    try {
      // Focus the scope first so addChatTab writes into the right scope.
      selectWorktree(projectId, worktreeId);
      const body: {
        title: string;
        provider: string;
        model: string;
        worktree_id?: string;
      } = {
        title: `chat in ${parentName}`,
        provider: "fake",
        model: "echo",
      };
      if (worktreeId) body.worktree_id = worktreeId;
      const chat = await api.createProjectChat(projectId, body);
      addChatTab({ id: chat.id, title: chat.title });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Resize state.
  const persisted = Number(localStorage.getItem(RAIL_LS_KEY));
  const initial =
    Number.isFinite(persisted) && persisted >= RAIL_MIN_PX && persisted <= RAIL_MAX_PX
      ? persisted
      : RAIL_DEFAULT_PX;
  const [width, setWidth] = createSignal(initial);
  const [dragging, setDragging] = createSignal(false);

  function clamp(px: number) {
    return Math.min(RAIL_MAX_PX, Math.max(RAIL_MIN_PX, Math.round(px)));
  }

  function onPointerDown(ev: PointerEvent) {
    ev.preventDefault();
    setDragging(true);
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  function onPointerMove(ev: PointerEvent) {
    if (!dragging()) return;
    // Rail's left edge is the page's left edge for our layout.
    const next = clamp(ev.clientX);
    setWidth(next);
  }
  function onPointerUp(ev: PointerEvent) {
    if (!dragging()) return;
    setDragging(false);
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch {
      // pointer might already be released
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(RAIL_LS_KEY, String(width()));
  }
  function onKeyDown(ev: KeyboardEvent) {
    let next = width();
    if (ev.key === "ArrowLeft") next -= ev.shiftKey ? 32 : 8;
    else if (ev.key === "ArrowRight") next += ev.shiftKey ? 32 : 8;
    else if (ev.key === "Home") next = RAIL_MIN_PX;
    else if (ev.key === "End") next = RAIL_MAX_PX;
    else if (ev.key === "Enter" || ev.key === " ") next = RAIL_DEFAULT_PX;
    else return;
    ev.preventDefault();
    setWidth(clamp(next));
    localStorage.setItem(RAIL_LS_KEY, String(width()));
  }

  // Safety: clear drag if the pointer is released outside the handle
  // (e.g. user releases while over an iframe).
  const onWindowUp = () => {
    if (!dragging()) return;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(RAIL_LS_KEY, String(width()));
  };
  onMount(() => {
    window.addEventListener("pointerup", onWindowUp);
    // Auto-expand the currently selected project on first mount so users
    // immediately see its file tree.
    const sel = state.selectedProjectId;
    if (sel) expand(sel);
  });
  onCleanup(() => window.removeEventListener("pointerup", onWindowUp));

  async function onSelect(path: string) {
    setErr(null);
    try {
      await api.createProject({ root: path });
      setPicking(false);
      await refreshProjects();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteProject(id: string, ev: MouseEvent) {
    ev.stopPropagation();
    const ok = await confirm({
      title: "Remove project",
      body: "Remove this project from AgentGrove? The folder on disk is not touched.",
      confirmLabel: "Remove",
      danger: true,
      testId: "confirm-remove-project",
    });
    if (!ok) return;
    await api.deleteProject(id);
    await refreshProjects();
  }

  return (
    <aside
      class="shrink-0 border-r border-border bg-transparent flex flex-col relative"
      style={{ width: `${width()}px` }}
      data-testid="left-rail"
    >
      <div class="px-5 h-12 flex items-center gap-2.5 border-b border-border">
        <Logo />
        <span class="text-[13.5px] font-semibold tracking-tight">AgentGrove</span>
      </div>

      <div class="flex-1 overflow-y-auto px-3 py-4">
        <div class="flex items-center justify-between px-2 mb-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
            Projects
          </h3>
          <button
            class="ag-btn ag-btn-ghost ag-btn-xs ag-btn-icon"
            onClick={() => setPicking(true)}
            data-testid="add-project-btn"
            aria-label="Add project"
            title="Add project"
          >
            <PlusIcon />
          </button>
        </div>

        <Show when={err()}>
          <p
            class="text-[11.5px] text-danger px-2 mb-2"
            data-testid="new-project-error"
          >
            {err()}
          </p>
        </Show>

        <Show when={picking()}>
          <FolderPicker
            onSelect={(p) => void onSelect(p)}
            onCancel={() => setPicking(false)}
          />
        </Show>

        <ul class="space-y-0.5" data-testid="project-list">
          <For
            each={state.projects}
            fallback={
              <li class="text-[12.5px] text-fg-subtle px-2 py-2">
                No projects yet. Click + to add one.
              </li>
            }
          >
            {(p) => {
              const isWorktree = looksLikeManagedWorktree(p.root);
              const kindLabel = isWorktree
                ? "Worktree"
                : p.is_git
                  ? p.has_remote
                    ? "Git repo with remote"
                    : "Git repo (no remote)"
                  : "Folder";
              const active = () =>
                state.selectedProjectId === p.id && currentWorktreeId() === null;
              const open = () => isExpanded(p.id);
              return (
                <li class="space-y-0.5">
                  <div
                    class="ag-list-item group"
                    classList={{ "is-active": active() }}
                    onClick={() => {
                      // Project row = project root scope.
                      selectWorktree(p.id, null);
                      expand(p.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectWorktree(p.id, null);
                        expand(p.id);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={active()}
                    aria-expanded={open()}
                    data-testid={`project-${p.id}`}
                    data-kind={isWorktree ? "worktree" : p.is_git ? "git" : "folder"}
                    data-has-remote={p.has_remote ? "true" : "false"}
                    data-expanded={open() ? "true" : "false"}
                    title={`${kindLabel} · ${p.root}`}
                  >
                    <button
                      type="button"
                      class="shrink-0 -ml-1 p-0.5 text-fg-subtle hover:text-fg"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(p.id);
                      }}
                      aria-label={open() ? "Collapse project" : "Expand project"}
                      title={open() ? "Collapse" : "Expand"}
                      data-testid={`toggle-project-${p.id}`}
                    >
                      <Chevron open={open()} />
                    </button>

                    {isWorktree ? <WorktreeIcon /> : <FolderIcon />}
                    <span class="truncate text-[13.5px] min-w-0 flex-1">{p.name}</span>

                    {/* Right-edge cluster: chips + action icons.
                        flex-nowrap + shrink-0 keep these on the same line; the
                        project name above absorbs any width shortage via min-w-0. */}
                    <div class="flex items-center gap-1 shrink-0 flex-nowrap">
                      {/* Worktree branch */}
                      <Show when={isWorktree && p.current_branch}>
                        <span
                          class="ag-chip ag-chip-accent font-mono !text-[10.5px] !py-[1px] whitespace-nowrap"
                          title={`Branch ${p.current_branch}`}
                        >
                          ⎇ {p.current_branch}
                        </span>
                      </Show>

                      {/* Regular git repo: show branch only. Remote state is
                          implicit via the visible "+ worktree" icon on the
                          right (only shown when has_remote is true). */}
                      <Show when={!isWorktree && p.is_git && p.current_branch}>
                        <span
                          class="ag-chip font-mono !text-[10.5px] !py-[1px] whitespace-nowrap"
                          title={
                            p.has_remote
                              ? `Branch ${p.current_branch} · remotes: ${(p.remotes ?? []).join(", ") || "yes"}`
                              : `Branch ${p.current_branch}`
                          }
                        >
                          ⎇ {p.current_branch}
                        </span>
                      </Show>

                      {/* + chat (icon-only). Creates a new chat scoped to
                          this project's root and switches to the Chat pane. */}
                      <button
                        type="button"
                        class="shrink-0 p-1 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          void newChat(p.id, null, p.name);
                        }}
                        aria-label={`New chat in ${p.name}`}
                        title="New chat"
                        data-testid={`new-chat-${p.id}`}
                      >
                        <ChatPlusIcon />
                      </button>

                      {/* Changes (git diff) — opens the right-side
                          Changes panel scoped to this project root. */}
                      <button
                        type="button"
                        class="shrink-0 p-1 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          setChangesScope({ path: p.root, label: p.name });
                        }}
                        aria-label={`View changes in ${p.name}`}
                        title="View changes"
                        data-testid={`changes-${p.id}`}
                      >
                        <DiffIcon />
                      </button>

                      {/* + worktree (icon-only). Only for projects with a remote.
                          Always visible (not hover-only) so users can find it
                          without hunting. */}
                      <Show when={p.has_remote}>
                        <button
                          type="button"
                          class="shrink-0 p-1 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            setWtFor(p.id);
                          }}
                          aria-label={`New worktree in ${p.name}`}
                          title="New worktree"
                          data-testid={`new-worktree-${p.id}`}
                        >
                          <BranchPlusIcon />
                        </button>
                        <button
                          type="button"
                          class="shrink-0 p-1 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            setHistoryFor(p.id);
                          }}
                          aria-label={`Worktree history for ${p.name}`}
                          title="Worktree history"
                          data-testid={`worktree-history-${p.id}`}
                        >
                          <HistoryIcon />
                        </button>
                      </Show>

                      <button
                        onClick={(e) => deleteProject(p.id, e)}
                        class="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-danger hover:bg-bg-2 transition-opacity"
                        aria-label={`Remove project ${p.name}`}
                        title="Remove"
                      >
                        <XIcon />
                      </button>
                    </div>
                  </div>

                  {/* Worktree list — rendered directly under the project row
                      (no sub-header). Only when expanded + the project has a
                      remote (worktrees require git+remote). */}
                  <Show when={open() && p.has_remote}>
                    <div class="mt-1 pl-4">
                      <ul class="space-y-0.5">
                        <For
                          each={state.worktrees[p.id] ?? []}
                          fallback={
                            <li class="text-[11.5px] text-fg-subtle italic px-2 py-1">
                              no worktrees yet
                            </li>
                          }
                        >
                          {(w) => {
                            const wtActive = () =>
                              state.selectedProjectId === p.id &&
                              currentWorktreeId() === w.id;
                            const wtOpen = () => isExpanded(w.id);
                            return (
                              <li class="space-y-0.5">
                                <div
                                  class="group flex items-center gap-1.5 px-2 py-[3px] rounded cursor-pointer"
                                  classList={{
                                    "bg-accent-soft": wtActive(),
                                    "hover:bg-bg-2": !wtActive(),
                                  }}
                                  onClick={() => {
                                    selectWorktree(p.id, w.id);
                                    expand(w.id);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      selectWorktree(p.id, w.id);
                                      expand(w.id);
                                    }
                                  }}
                                  tabIndex={0}
                                  role="button"
                                  aria-pressed={wtActive()}
                                  aria-expanded={wtOpen()}
                                  data-testid={`worktree-${w.id}`}
                                  data-expanded={wtOpen() ? "true" : "false"}
                                  title={w.path}
                                >
                                  <button
                                    type="button"
                                    class="shrink-0 -ml-1 p-0.5 text-fg-subtle hover:text-fg"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleExpanded(w.id);
                                    }}
                                    aria-label={wtOpen() ? "Collapse worktree" : "Expand worktree"}
                                    title={wtOpen() ? "Collapse" : "Expand"}
                                    data-testid={`toggle-worktree-${w.id}`}
                                  >
                                    <Chevron open={wtOpen()} />
                                  </button>
                                  <WorktreeIcon />
                                  <span class="truncate text-[12.5px] font-mono min-w-0 flex-1">
                                    {w.branch}
                                  </span>
                                  {/* Status chip only when not in the steady
                                      "ready" state — keeps the row quiet
                                      while still surfacing failures + busy
                                      transitions. */}
                                  <Show when={w.status !== "ready"}>
                                    <span
                                      class="ml-auto ag-chip !text-[10px] !py-[1px] whitespace-nowrap"
                                      classList={{
                                        "ag-chip-warn":
                                          w.status === "creating" ||
                                          w.status === "pre_script",
                                        "!text-danger": w.status === "failed",
                                      }}
                                      title={`Status: ${w.status}`}
                                    >
                                      {w.status}
                                    </span>
                                  </Show>
                                  {/* + chat under this worktree */}
                                  <button
                                    type="button"
                                    class="shrink-0 ml-auto p-0.5 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                                    classList={{
                                      "!ml-1": w.status !== "ready",
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void newChat(p.id, w.id, w.branch);
                                    }}
                                    aria-label={`New chat in worktree ${w.branch}`}
                                    title="New chat"
                                    data-testid={`new-chat-wt-${w.id}`}
                                  >
                                    <ChatPlusIcon />
                                  </button>
                                  {/* Changes for this worktree */}
                                  <button
                                    type="button"
                                    class="shrink-0 p-0.5 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setChangesScope({ path: w.path, label: w.branch });
                                    }}
                                    aria-label={`View changes in worktree ${w.branch}`}
                                    title="View changes"
                                    data-testid={`changes-wt-${w.id}`}
                                  >
                                    <DiffIcon />
                                  </button>
                                  <button
                                    onClick={(e) => deleteWorktree(p.id, w.id, e)}
                                    class="opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-danger p-0.5"
                                    aria-label={`Remove worktree ${w.branch}`}
                                    title="Remove"
                                  >
                                    <XIcon />
                                  </button>
                                </div>

                                {/* Inline file tree rooted at the worktree's path. */}
                                <Show when={wtOpen()}>
                                  <DirNode path={w.path} depth={2} initiallyOpen />
                                </Show>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </div>
                  </Show>

                  {/* Helper hint when project is a git repo without a remote. */}
                  <Show when={open() && p.is_git && !p.has_remote && !isWorktree}>
                    <p class="px-2 mt-2 text-[11px] text-fg-subtle italic">
                      Add a git remote to enable worktrees.
                    </p>
                  </Show>

                  {/* Inline file tree for the project (when expanded). */}
                  <Show when={open()}>
                    <DirNode path={p.root} depth={1} initiallyOpen />
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </div>

      {/* Resize handle: thin vertical strip on the right edge. Pointer
          events drive width(); ←/→ + Home/End nudge it from the keyboard. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left panel"
        aria-valuemin={RAIL_MIN_PX}
        aria-valuemax={RAIL_MAX_PX}
        aria-valuenow={width()}
        tabIndex={0}
        class="absolute top-0 right-0 h-full w-1.5 -mr-[3px] cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10 touch-none"
        classList={{ "!bg-accent/50": dragging() }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        data-testid="left-rail-resize"
      />

      <Show when={wtFor()} keyed>
        {(pid) => {
          const proj = state.projects.find((p) => p.id === pid);
          const defaultBaseRef =
            proj?.current_branch?.trim() && proj.current_branch.trim() !== "HEAD"
              ? proj.current_branch
              : undefined;
          return (
            <WorktreeDialog
              projectId={pid}
              defaultBaseRef={defaultBaseRef}
              onCancel={() => setWtFor(null)}
              onCreated={() => {
                setWtFor(null);
                void refreshWorktreesForProject(pid);
              }}
            />
          );
        }}
      </Show>

      <Show when={historyFor()} keyed>
        {(pid) => (
          <WorktreeHistoryDialog
            projectId={pid}
            onClose={() => setHistoryFor(null)}
            onRestored={() => void refreshWorktreesForProject(pid)}
          />
        )}
      </Show>
    </aside>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2 4 7v10l8 5 8-5V7l-8-5Z"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path
        d="M12 12 4 7m8 5 8-5m-8 5v10"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      class="text-fg-subtle shrink-0"
      aria-hidden="true"
    >
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Branch / worktree glyph. Distinct from FolderIcon so users can tell at
 *  a glance which entries are worktrees. */
function WorktreeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      class="text-accent shrink-0"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2.2" stroke="currentColor" stroke-width="1.6" />
      <circle cx="6" cy="18" r="2.2" stroke="currentColor" stroke-width="1.6" />
      <circle cx="18" cy="12" r="2.2" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M6 8v8M8 6h6a4 4 0 0 1 4 4v0M8 18h6a4 4 0 0 0 4-4v0"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** Branch icon with a small `+` glyph in the corner — used as the
 *  inline "+ worktree" action on the project row. */
function BranchPlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      class="shrink-0"
      aria-hidden="true"
    >
      {/* branching glyph (left two nodes + line) */}
      <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.6" />
      <circle cx="6" cy="18" r="2" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M6 8v8M8 6h5a3 3 0 0 1 3 3v3"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
      {/* `+` */}
      <path
        d="M19 12v6M16 15h6"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** Speech bubble with a small `+` glyph in the corner — used as the
 *  inline "+ chat" action on project + worktree rows. */
function DiffIcon() {
  // Two stacked rectangles with +/- markers — represents "compare".
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      class="shrink-0"
      aria-hidden="true"
    >
      <path d="M9 4H5a1 1 0 0 0-1 1v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M15 20h4a1 1 0 0 0 1-1V9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M7 9V5M5 7h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M15 17h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M14 4l-4 4M14 14l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2 2" />
    </svg>
  );
}

function HistoryIcon() {
  // Clock with arrow — represents "history / restore".
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      class="shrink-0"
      aria-hidden="true"
    >
      <path
        d="M3 12a9 9 0 1 0 3.2-6.9"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
      <path d="M3 4v5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      <path
        d="M12 7v5l3 2"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function ChatPlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      class="shrink-0"
      aria-hidden="true"
    >
      {/* speech bubble */}
      <path
        d="M4 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-1-1.7V5Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      {/* `+` glyph in the corner */}
      <path
        d="M19 13v6M16 16h6"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** Heuristic: does this folder path look like a worktree AgentGrove created
 *  itself? Managed worktrees live under `<state_dir>/worktrees/<project_id>/<branch>`.
 *  We don't have the BE state_dir on the FE, so we match on the substring. */
function looksLikeManagedWorktree(path: string): boolean {
  return /\/worktrees\/[^/]+\/[^/]+\/?$/.test(path) || /\.data\/worktrees\//.test(path);
}

// ---------- inline file tree ----------

interface DirNodeProps {
  path: string;
  depth: number;
  initiallyOpen?: boolean;
}

/** Lists the children of `path`. Renders as a nested <ul>. Lazy-loaded
 *  when `open === true`. */
function DirNode(props: DirNodeProps) {
  const [open] = createSignal(props.initiallyOpen ?? true);
  const [entries] = createResource(open, async (isOpen) => {
    if (!isOpen) return [] as TreeEntry[];
    try {
      return await api.listTree(props.path, true);
    } catch {
      return [] as TreeEntry[];
    }
  });

  return (
    <ul class="space-y-px">
      <For each={entries() ?? []}>
        {(entry) => (
          <Show
            when={entry.is_dir}
            fallback={
              <FileRow path={entry.path} name={entry.name} depth={props.depth} />
            }
          >
            <FolderRow path={entry.path} name={entry.name} depth={props.depth} />
          </Show>
        )}
      </For>
      <Show when={open() && entries.loading}>
        <li
          class="px-2 py-1 text-[11.5px] text-fg-subtle"
          style={{ "padding-left": `${8 + props.depth * 12}px` }}
        >
          loading…
        </li>
      </Show>
      <Show when={open() && !entries.loading && (entries()?.length ?? 0) === 0}>
        <li
          class="px-2 py-1 text-[11.5px] text-fg-subtle"
          style={{ "padding-left": `${8 + props.depth * 12}px` }}
        >
          (empty)
        </li>
      </Show>
    </ul>
  );
}

function FolderRow(props: { path: string; name: string; depth: number }) {
  const [open, setOpen] = createSignal(false);
  return (
    <li>
      <button
        type="button"
        class="w-full flex items-center gap-1.5 px-2 py-[3px] rounded hover:bg-bg-2 text-fg-muted hover:text-fg cursor-pointer select-none text-left"
        style={{ "padding-left": `${8 + props.depth * 12}px` }}
        onClick={() => setOpen(!open())}
        title={props.path}
        data-testid={`tree-folder-${props.path}`}
      >
        <Chevron open={open()} />
        <TreeFolderIcon />
        <span class="truncate text-[12.5px]">{props.name}</span>
      </button>
      <Show when={open()}>
        <DirNode path={props.path} depth={props.depth + 1} />
      </Show>
    </li>
  );
}

function FileRow(props: { path: string; name: string; depth: number }) {
  const isActive = () => selectedFilePath() === props.path;
  return (
    <li>
      <button
        type="button"
        class="w-full flex items-center gap-1.5 px-2 py-[3px] rounded text-left cursor-pointer select-none"
        classList={{
          "bg-accent-soft text-fg": isActive(),
          "hover:bg-bg-2 text-fg-muted hover:text-fg": !isActive(),
        }}
        style={{ "padding-left": `${20 + props.depth * 12}px` }}
        onClick={() => selectFile(props.path)}
        title={props.path}
        data-testid={`tree-file-${props.path}`}
      >
        <TreeFileIcon />
        <span class="truncate text-[12.5px]">{props.name}</span>
      </button>
    </li>
  );
}

function Chevron(props: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{
        transform: props.open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
        color: "var(--ag-fg-subtle)",
      }}
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function TreeFolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class="text-fg-subtle shrink-0"
    >
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function TreeFileIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class="text-fg-subtle shrink-0"
    >
      <path
        d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path d="M14 3v6h6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
    </svg>
  );
}
