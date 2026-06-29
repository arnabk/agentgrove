import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  api,
  logClient,
  type Project,
  type TreeEntry,
  type WorktreeRemoteStatus,
} from "../api/client";
import {
  addChatTab,
  addTerminalTab,
  currentScopeKey,
  currentWorktreeId,
  isProjectWorking,
  isScopeWorking,
  refreshProjects,
  refreshWorktreesForProject,
  selectFile,
  selectWorktree,
  setPendingChatInjection,
  selectedChatId,
  selectedFilePath,
  setChangesScope,
  setState,
  state,
  type TerminalTab,
} from "../stores/app";
import { confirm } from "./dialog";
import { pushToast } from "./Toast";
import FolderPicker from "./FolderPicker";
import NewChatDialog from "./NewChatDialog";
import WorktreeDialog from "./WorktreeDialog";
import WorktreeHistoryDialog from "./WorktreeHistoryDialog";
import ChatHistoryDialog from "./ChatHistoryDialog";
import RenameWorktreeDialog from "./RenameWorktreeDialog";
import ProjectSettingsDialog from "./ProjectSettingsDialog";

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
/** Persisted toggle: show inline file/folder trees under project +
 *  worktree rows, or hide them (worktrees-only view). Default true
 *  so existing users see the same UI on first load. */
const RAIL_SHOW_FILES_LS_KEY = "ag-rail-show-files";

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
  const [chatHistoryFor, setChatHistoryFor] = createSignal<{
    projectId: string;
    worktreeId?: string | null;
  } | null>(null);
  // Active rename target (projectId + worktreeId + currentBranch) or
  // null when the rename dialog is closed.
  const [renameFor, setRenameFor] = createSignal<{
    projectId: string;
    worktreeId: string;
    currentBranch: string;
  } | null>(null);
  // Active project whose settings dialog is open; null when closed.
  // We keep the full Project object (not just an id) so the dialog
  // can read the current `pre_worktree_script` immediately without a
  // second fetch.
  const [settingsFor, setSettingsFor] = createSignal<Project | null>(null);
  // Pending new-chat context. null when the dialog is closed.
  interface NewChatCtx {
    projectId: string;
    worktreeId: string | null;
    parentName: string;
  }
  const [newChatFor, setNewChatFor] = createSignal<NewChatCtx | null>(null);

  // Which project/worktree row's overflow (kebab) menu is open, keyed by
  // the row id, or null. The secondary actions (changes, worktree,
  // history, settings, remove) live in this menu so each row shows only
  // a couple of quick-create icons + a kebab — nothing clips when the
  // rail is narrowed; the project name truncates instead.
  const [openMenuFor, setOpenMenuFor] = createSignal<string | null>(null);
  const [mergingWt, setMergingWt] = createSignal<string | null>(null);
  onMount(() => {
    // Close the menu on a click that lands OUTSIDE the kebab button + its
    // dropdown, or on Escape. We test the event target rather than relying
    // on stopPropagation: Solid delegates events to the document root, so
    // a `stopPropagation()` in a Solid onClick won't reliably stop this
    // natively-registered listener — checking the target is robust.
    const onDocClick = (e: MouseEvent) => {
      if (openMenuFor() === null) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-testid^="project-menu-"]')) return;
      setOpenMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenuFor(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });

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

  // Use a SolidJS store (not a plain signal) so reads like
  // `remoteStatus[w.id]?.diverged` inside <For> bodies get
  // fine-grained reactivity — a createSignal<Record> doesn't
  // track individual keys, so <Show> inside <For> wouldn't
  // re-evaluate when a specific worktree's status changed.
  const [remoteStatus, setRemoteStatusStore] = createStore<Record<string, WorktreeRemoteStatus>>(
    {},
  );
  // Quick check via `git ls-remote` is cheap (no object download) so
  // we can poll more frequently than a full fetch.
  const DRIFT_POLL_MS = 60 * 1000;
  function fetchDrift(worktreeId: string) {
    void api
      .worktreeRemoteStatus(worktreeId)
      .then((rs) =>
        setRemoteStatusStore(
          produce((s) => {
            s[worktreeId] = rs;
          }),
        ),
      )
      .catch(() => {});
  }
  createEffect(() => {
    for (const p of state.projects) {
      if (!isExpanded(p.id)) continue;
      for (const w of state.worktrees[p.id] ?? []) fetchDrift(w.id);
    }
    const h = setInterval(() => {
      for (const p of state.projects) {
        if (!isExpanded(p.id)) continue;
        for (const w of state.worktrees[p.id] ?? []) fetchDrift(w.id);
      }
    }, DRIFT_POLL_MS);
    onCleanup(() => clearInterval(h));
  });

  async function deleteWorktree(projectId: string, wtId: string, ev: MouseEvent) {
    ev.stopPropagation();
    // Local controlled signal for the checkbox embedded in the
    // confirm dialog body. We deliberately keep this scoped to the
    // function so each invocation starts unchecked (the destructive
    // "also delete branch" option should NEVER be remembered between
    // invocations).
    const [alsoDeleteBranch, setAlsoDeleteBranch] = createSignal(false);
    const ok = await confirm({
      title: "Remove worktree",
      body: (
        <div class="space-y-3">
          <p>Remove this worktree from disk and AgentGrove?</p>
          <label class="flex items-center gap-2 text-[12.5px] text-fg select-none">
            <input
              type="checkbox"
              class="h-3.5 w-3.5 accent-accent cursor-pointer"
              checked={alsoDeleteBranch()}
              onChange={(e) => setAlsoDeleteBranch(e.currentTarget.checked)}
              data-testid="confirm-remove-worktree-also-delete-branch"
            />
            Also delete the local branch (<code class="font-mono">git branch -D</code>)
          </label>
        </div>
      ),
      confirmLabel: "Remove",
      danger: true,
      testId: "confirm-remove-worktree",
    });
    if (!ok) return;
    // Optimistic delete: drop the row from the local store IMMEDIATELY
    // so the UI doesn't freeze while git removes (potentially large)
    // worktree contents on disk. We snapshot the previous list so we
    // can roll back if the BE call ultimately fails. The active-scope
    // fallback also runs optimistically — otherwise the user would
    // see a phantom worktree pane until the BE responded.
    const prevList = state.worktrees[projectId] ?? [];
    const optimistic = prevList.filter((w) => w.id !== wtId);
    setState("worktrees", projectId, optimistic);
    const wasActiveScope =
      state.selectedProjectId === projectId && state.selectedWorktreeByProject[projectId] === wtId;
    if (wasActiveScope) {
      selectWorktree(projectId, null);
    }
    try {
      await api.deleteWorktree(projectId, wtId, {
        deleteBranch: alsoDeleteBranch(),
      });
      // Reconcile against the BE's authoritative list — picks up
      // status flips (e.g. soft-deleted siblings) we don't track
      // locally. Fire-and-forget; we already showed the optimistic
      // state.
      void refreshWorktreesForProject(projectId);
    } catch (e) {
      // Roll back the local store so the row reappears, and tell
      // the user what went wrong. We deliberately do NOT restore the
      // previous active scope — the user already navigated away and
      // unwinding that would be jarring.
      setState("worktrees", projectId, prevList);
      setErr(`Could not remove worktree: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Open the new-chat dialog scoped to (projectId, optional worktreeId).
   *  The dialog handles provider / model selection; on success we
   *  switch to the new chat and add it to the tab strip. */
  function openNewChatDialog(projectId: string, worktreeId: string | null, parentName: string) {
    setErr(null);
    // Focus the scope first so addChatTab on creation writes into it.
    selectWorktree(projectId, worktreeId);
    setNewChatFor({ projectId, worktreeId, parentName });
  }

  /** Open a new terminal at a project root or worktree path. Mirrors
   *  the "+ chat" button on each row but spawns a PTY session in the
   *  matching folder and switches the pane focus to Terminal.
   *
   *  Flow:
   *    1. Make the row's scope the active one — terminals are stored
   *       per-scope, so spawning into the wrong scope would hide the
   *       terminal under a different tab strip.
   *    2. Hit `POST /api/terminals` with `project_id` (+ optional
   *       `worktree_id`) so the BE resolves `cwd` itself. Default
   *       `cols`/`rows` match TerminalPane's first spawn.
   *    3. Push the resulting tab via `addTerminalTab` — that helper
   *       already flips `activePane = "terminal"` + selects the new
   *       session.
   *
   *  Errors are surfaced through the same `err` signal the other
   *  row actions use; we don't gate behind a dialog because the
   *  intent is "give me a shell here, right now".
   */
  async function openTerminalAt(projectId: string, worktreeId: string | null, label: string) {
    setErr(null);
    // Activate the row's scope BEFORE spawning so the terminal lands
    // in the correct per-scope tab strip.
    selectWorktree(projectId, worktreeId);
    try {
      const t = await api.createTerminal({
        cols: 80,
        rows: 24,
        project_id: projectId,
        ...(worktreeId ? { worktree_id: worktreeId } : {}),
      });
      const scope = state.byScope[currentScopeKey() ?? ""];
      const tab: TerminalTab = {
        id: t.id,
        cwd: t.cwd,
        // Match TerminalPane's naming convention so labels stay
        // consistent regardless of where the terminal was created.
        label: `term ${(scope?.tabs.filter((t) => t.kind === "terminal").length ?? 0) + 1}`,
      };
      const res = addTerminalTab(tab);
      if (!res.ok) setErr(res.reason ?? `could not open terminal in ${label}`);
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
  // Whether to render the inline file/folder trees under each
  // project + worktree row. Some users only care about worktrees +
  // chats and find the file lists noisy, so we let them collapse to
  // a worktree-only view. Persisted to localStorage so the choice
  // survives reloads.
  const [showFiles, setShowFiles] = createSignal(
    localStorage.getItem(RAIL_SHOW_FILES_LS_KEY) !== "0",
  );
  createEffect(() => {
    localStorage.setItem(RAIL_SHOW_FILES_LS_KEY, showFiles() ? "1" : "0");
  });

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
      style={{
        width: `${width()}px`,
        "font-size": "var(--ag-font-size, 15px)",
      }}
      data-testid="left-rail"
    >
      <div class="px-5 h-12 flex items-center gap-2.5 border-b border-border">
        <Logo />
        <span class="text-[0.9em] font-semibold tracking-tight">AgentGrove</span>
      </div>

      <div class="flex-1 overflow-y-auto px-3 py-4">
        <div class="flex items-center justify-between px-2 mb-2">
          <h3 class="text-[0.8em] font-semibold uppercase tracking-wider text-fg-subtle">
            Projects
          </h3>
          <div class="flex items-center gap-1">
            {/* Toggle: show vs hide inline file/folder trees. When
                hidden, the rail collapses to projects + worktrees +
                their action icons, which is what users running long
                code reviews want — no noisy filename lists. The
                icon swaps to indicate the current state. */}
            <button
              class="ag-btn ag-btn-ghost ag-btn-xs ag-btn-icon"
              onClick={() => setShowFiles(!showFiles())}
              data-testid="toggle-files"
              aria-label={showFiles() ? "Hide files and folders" : "Show files and folders"}
              aria-pressed={showFiles()}
              title={showFiles() ? "Hide files and folders" : "Show files and folders"}
            >
              <Show when={showFiles()} fallback={<FilesOffIcon />}>
                <FilesOnIcon />
              </Show>
            </button>
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
        </div>

        <Show when={err()}>
          <p class="text-[0.77em] text-danger px-2 mb-2" data-testid="new-project-error">
            {err()}
          </p>
        </Show>

        <Show when={picking()}>
          <FolderPicker onSelect={(p) => void onSelect(p)} onCancel={() => setPicking(false)} />
        </Show>

        <ul class="space-y-0.5" data-testid="project-list">
          <For each={state.projects}>
            {(p) => {
              const isWorktree = looksLikeManagedWorktree(p.root);
              const kindLabel = isWorktree
                ? "Worktree"
                : p.is_git
                  ? p.has_remote
                    ? "Git repo with remote"
                    : "Git repo (no remote)"
                  : "Folder";
              const active = () => state.selectedProjectId === p.id && currentWorktreeId() === null;
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
                    <span class="truncate text-[0.97em] min-w-0 flex-1">{p.name}</span>

                    {/* "Working" dot. While collapsed it summarises ANY
                        busy chat under the project (root or worktree);
                        once expanded it narrows to the root scope so the
                        busy worktree rows below carry their own dots and
                        we don't show two indicators for the same turn. */}
                    <Show when={open() ? isScopeWorking(p.id, null) : isProjectWorking(p.id)}>
                      <WorkingDot
                        title={
                          open()
                            ? "A chat in this project's root is working…"
                            : "A chat in this project is working…"
                        }
                      />
                    </Show>

                    {/* Right-edge cluster: branch chip + a single overflow
                        (kebab) menu holding every row action. Keeping just
                        the kebab inline means the cluster never outgrows the
                        row — the project name truncates via min-w-0 instead
                        of icons clipping — and every action has a text label. */}
                    <div class="flex items-center gap-0.5 shrink-0 flex-nowrap">
                      {/* Worktree branch */}
                      <Show when={isWorktree && p.current_branch}>
                        <span
                          class="ag-chip ag-chip-accent font-mono !text-[0.77em] !py-[2px] whitespace-nowrap"
                          title={`Branch ${p.current_branch}`}
                        >
                          ⎇ {p.current_branch}
                        </span>
                      </Show>

                      {/* Overflow menu: every project action lives here now
                          (new chat, new terminal, changes, worktree, history,
                          settings, remove). Absolutely-positioned dropdown so
                          it never clips, even on a narrow rail. */}
                      <div class="relative shrink-0">
                        <button
                          type="button"
                          class="shrink-0 p-1 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                          classList={{ "!text-fg !bg-bg-3": openMenuFor() === p.id }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuFor(openMenuFor() === p.id ? null : p.id);
                          }}
                          aria-label={`More actions for ${p.name}`}
                          aria-haspopup="menu"
                          aria-expanded={openMenuFor() === p.id}
                          title="More actions"
                          data-testid={`project-menu-${p.id}`}
                        >
                          <KebabIcon />
                        </button>
                        <Show when={openMenuFor() === p.id}>
                          <div
                            role="menu"
                            class="absolute right-0 top-full mt-1 z-30 min-w-[170px] py-1 rounded-lg border border-border bg-bg-1 shadow-xl text-[12.5px]"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`project-menu-list-${p.id}`}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                              onClick={() => {
                                setOpenMenuFor(null);
                                openNewChatDialog(p.id, null, p.name);
                              }}
                              data-testid={`new-chat-${p.id}`}
                            >
                              <ChatPlusIcon /> New chat
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                              onClick={() => {
                                setOpenMenuFor(null);
                                void openTerminalAt(p.id, null, p.name);
                              }}
                              data-testid={`new-terminal-${p.id}`}
                            >
                              <TerminalPlusIcon /> New terminal
                            </button>
                            <div class="my-1 border-t border-border" />
                            <Show when={p.is_git}>
                              <button
                                type="button"
                                role="menuitem"
                                class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                onClick={() => {
                                  setOpenMenuFor(null);
                                  setChangesScope({ path: p.root, label: p.name });
                                }}
                                data-testid={`changes-${p.id}`}
                              >
                                <DiffIcon /> View changes
                              </button>
                            </Show>
                            <Show when={p.has_remote}>
                              <button
                                type="button"
                                role="menuitem"
                                class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                onClick={() => {
                                  setOpenMenuFor(null);
                                  setWtFor(p.id);
                                }}
                                data-testid={`new-worktree-${p.id}`}
                              >
                                <BranchPlusIcon /> New worktree
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                onClick={() => {
                                  setOpenMenuFor(null);
                                  setHistoryFor(p.id);
                                }}
                                data-testid={`worktree-history-${p.id}`}
                              >
                                <HistoryIcon /> Worktree history
                              </button>
                            </Show>
                            <button
                              type="button"
                              role="menuitem"
                              class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                              onClick={() => {
                                setOpenMenuFor(null);
                                setChatHistoryFor({ projectId: p.id });
                              }}
                              data-testid={`chat-history-${p.id}`}
                            >
                              <HistoryIcon /> Chat history
                            </button>
                            <Show when={p.is_git}>
                              <button
                                type="button"
                                role="menuitem"
                                class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                onClick={() => {
                                  setOpenMenuFor(null);
                                  setSettingsFor(p);
                                }}
                                data-testid={`project-settings-${p.id}`}
                              >
                                <GearIcon /> Project settings
                              </button>
                            </Show>
                            <div class="my-1 border-t border-border" />
                            <button
                              type="button"
                              role="menuitem"
                              class="w-full text-left px-3 py-1.5 flex items-center gap-2 text-danger hover:bg-bg-2"
                              onClick={(e) => {
                                setOpenMenuFor(null);
                                deleteProject(p.id, e);
                              }}
                              data-testid={`remove-project-${p.id}`}
                            >
                              <XIcon /> Remove project
                            </button>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </div>

                  {/* Worktree list — rendered directly under the project row
                      (no sub-header). Only when expanded + the project has a
                      remote (worktrees require git+remote). */}
                  <Show when={open() && p.has_remote}>
                    <div class="mt-1 pl-4">
                      <ul class="space-y-0.5">
                        <For each={state.worktrees[p.id] ?? []}>
                          {(w) => {
                            const wtActive = () =>
                              state.selectedProjectId === p.id && currentWorktreeId() === w.id;
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
                                  <span class="truncate text-[0.83em] font-mono min-w-0 flex-1">
                                    {w.branch}
                                  </span>
                                  <Show when={isScopeWorking(p.id, w.id)}>
                                    <WorkingDot title="A chat in this worktree is working…" />
                                  </Show>
                                  <Show
                                    when={
                                      remoteStatus[w.id]?.diverged ||
                                      (remoteStatus[w.id]?.behind ?? 0) > 0
                                    }
                                  >
                                    <button
                                      type="button"
                                      class="ag-chip ag-chip-warn !text-[0.65em] !py-[1px] shrink-0 cursor-pointer hover:opacity-80"
                                      title={
                                        (remoteStatus[w.id]?.behind ?? 0) > 0
                                          ? `${remoteStatus[w.id]!.behind} behind ${remoteStatus[w.id]!.tracking ?? "remote"} — click to sync`
                                          : `Branch drifted from ${remoteStatus[w.id]?.tracking ?? "remote"} — click to sync`
                                      }
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        fetchDrift(w.id);
                                        // Switch to this worktree's scope
                                        selectWorktree(p.id, w.id);
                                        const tracking =
                                          remoteStatus[w.id]?.tracking ?? "origin/" + w.branch;
                                        const text = `Pull latest from ${tracking} into this worktree's branch, merge, and resolve any conflicts.`;
                                        // If a chat is already open for this scope, hand the
                                        // sync prompt to ChatPane via the injection signal —
                                        // it runs the SAME optimistic insert the composer
                                        // uses, so the user bubble appears instantly instead
                                        // of waiting for the BE round-trip. Otherwise open a
                                        // new chat; the signal is consumed once that chat is
                                        // active.
                                        const chatId = selectedChatId();
                                        if (chatId) {
                                          setPendingChatInjection({ chatId, text });
                                        } else {
                                          setPendingChatInjection({ chatId: "", text });
                                          openNewChatDialog(p.id, w.id, w.branch);
                                        }
                                      }}
                                      data-testid={`drift-${w.id}`}
                                    >
                                      {(remoteStatus[w.id]?.behind ?? 0) > 0
                                        ? `↓${remoteStatus[w.id]!.behind}`
                                        : "↓"}
                                    </button>
                                  </Show>
                                  <Show
                                    when={
                                      remoteStatus[w.id]?.ahead && remoteStatus[w.id]!.ahead > 0
                                    }
                                  >
                                    <span
                                      class="ag-chip !text-[0.65em] !py-[1px] shrink-0"
                                      title={`${remoteStatus[w.id]!.ahead} commits ahead of ${remoteStatus[w.id]!.tracking ?? "remote"}`}
                                    >
                                      ↑{remoteStatus[w.id]!.ahead}
                                    </span>
                                  </Show>
                                  <Show when={remoteStatus[w.id]?.pr}>
                                    {(() => {
                                      const pr = remoteStatus[w.id]!.pr!;
                                      const label = pr.source === "glab" ? "MR" : "PR";
                                      const checksOk = pr.checks_status === "success";
                                      const canMerge =
                                        pr.state === "open" &&
                                        checksOk &&
                                        (pr.review_decision === "approved" || !pr.review_decision);
                                      const isMerging = () => mergingWt() === w.id;
                                      return (
                                        <>
                                          <a
                                            href={pr.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="ag-chip ag-chip-accent !text-[0.65em] !py-[1px] shrink-0 cursor-pointer hover:opacity-80"
                                            title={`${label} #${pr.number}: ${pr.title} (${pr.state})`}
                                            onClick={(ev) => ev.stopPropagation()}
                                            data-testid={`pr-${w.id}`}
                                          >
                                            {label} #{pr.number}
                                          </a>
                                          <Show when={canMerge}>
                                            <button
                                              type="button"
                                              disabled={isMerging()}
                                              class="ag-chip ag-chip-success !text-[0.6em] !py-[1px] shrink-0 cursor-pointer hover:opacity-80 font-semibold disabled:opacity-50"
                                              title={
                                                isMerging()
                                                  ? "Merging…"
                                                  : `Merge ${label} #${pr.number}`
                                              }
                                              onClick={async (ev) => {
                                                ev.stopPropagation();
                                                if (isMerging()) return;
                                                setMergingWt(w.id);
                                                try {
                                                  await api.mergePr(w.id, pr.number, pr.source);
                                                  pushToast({
                                                    title: "Merge queued",
                                                    message: `${label} #${pr.number} — merging once checks pass.`,
                                                  });
                                                  fetchDrift(w.id);
                                                } catch (e) {
                                                  const msg =
                                                    e instanceof Error ? e.message : String(e);
                                                  // Persist the FULL error (untruncated) to the
                                                  // client log for debugging; show a trimmed
                                                  // version in the toast so it stays readable.
                                                  logClient({
                                                    level: "error",
                                                    title: "Merge failed",
                                                    message: msg,
                                                    context: {
                                                      worktreeId: w.id,
                                                      branch: w.branch,
                                                      prNumber: pr.number,
                                                      source: pr.source,
                                                    },
                                                  });
                                                  pushToast({
                                                    level: "error",
                                                    title: "Merge failed",
                                                    message:
                                                      msg.length > 120
                                                        ? msg.slice(0, 120) + "…"
                                                        : msg,
                                                  });
                                                  fetchDrift(w.id);
                                                } finally {
                                                  setMergingWt(null);
                                                }
                                              }}
                                              data-testid={`merge-pr-${w.id}`}
                                            >
                                              {isMerging() ? "▸ …" : "▸ Merge"}
                                            </button>
                                          </Show>
                                          <Show when={!canMerge && pr.checks_status === "pending"}>
                                            <span
                                              class="ag-chip ag-chip-warn !text-[0.6em] !py-[1px] shrink-0"
                                              title="CI checks in progress"
                                            >
                                              ⏳ checks
                                            </span>
                                          </Show>
                                          <Show when={!canMerge && pr.checks_status === "failure"}>
                                            <span
                                              class="ag-chip ag-chip-danger !text-[0.6em] !py-[1px] shrink-0"
                                              title="CI checks failing"
                                            >
                                              ✗ checks
                                            </span>
                                          </Show>
                                          <Show
                                            when={
                                              !canMerge &&
                                              pr.review_decision &&
                                              pr.checks_status === "success"
                                            }
                                          >
                                            <span
                                              class="ag-chip ag-chip-warn !text-[0.6em] !py-[1px] shrink-0"
                                              title={`Review: ${pr.review_decision}`}
                                            >
                                              {pr.review_decision === "review_required"
                                                ? "👁 review"
                                                : "✗ changes"}
                                            </span>
                                          </Show>
                                        </>
                                      );
                                    })()}
                                  </Show>
                                  {/* Suggest installing the forge CLI if the
                                      repo is on a known forge but the CLI
                                      isn't installed — so the user knows
                                      they could have PR/MR badges. */}
                                  <Show
                                    when={
                                      remoteStatus[w.id]?.forge &&
                                      !remoteStatus[w.id]!.forge!.cli_installed &&
                                      remoteStatus[w.id]!.forge!.install_hint
                                    }
                                  >
                                    <span
                                      class="ag-chip !text-[0.6em] !py-[1px] shrink-0 text-fg-subtle cursor-help"
                                      title={remoteStatus[w.id]!.forge!.install_hint!}
                                    >
                                      💡 install {remoteStatus[w.id]!.forge!.cli}
                                    </span>
                                  </Show>
                                  {/* Status chip only for states a user can
                                      act on. We deliberately suppress:
                                        - "ready"    — the steady state; the
                                                       row already reads as
                                                       fine without a label.
                                        - "removing" — an internal lifecycle
                                                       state used by the BE
                                                       to gate concurrent
                                                       deletes. If a row is
                                                       still visible in this
                                                       list while marked
                                                       `removing`, the
                                                       previous delete call
                                                       was interrupted (BE
                                                       crash, abandoned tab,
                                                       …). Showing it as a
                                                       sticky pill confused
                                                       users; they can just
                                                       re-click the X to
                                                       retry the delete. */}
                                  <Show when={w.status !== "ready" && w.status !== "removing"}>
                                    <span
                                      class="ml-auto ag-chip !text-[0.67em] !py-[1px] whitespace-nowrap"
                                      classList={{
                                        "ag-chip-warn":
                                          w.status === "creating" || w.status === "pre_script",
                                        "!text-danger": w.status === "failed",
                                      }}
                                      title={`Status: ${w.status}`}
                                    >
                                      {w.status}
                                    </span>
                                  </Show>
                                  {/* Overflow menu: every worktree action
                                      lives here now (new chat, new terminal,
                                      changes, rename, remove). Keyed `wt:<id>`
                                      so it doesn't collide with a project
                                      row's menu key. `ml-auto` keeps the
                                      cluster right-aligned now that the inline
                                      quick-actions are gone. */}
                                  <div
                                    class="relative shrink-0 ml-auto"
                                    classList={{
                                      // Tighten the gap only when a status chip
                                      // is ACTUALLY rendered (noisy transient
                                      // state). Steady "ready"/"removing"
                                      // states should NOT trigger the inset.
                                      "!ml-1": w.status !== "ready" && w.status !== "removing",
                                    }}
                                  >
                                    <button
                                      type="button"
                                      class="shrink-0 p-0.5 rounded text-fg-subtle hover:text-accent hover:bg-bg-2"
                                      classList={{
                                        "!text-fg !bg-bg-3": openMenuFor() === `wt:${w.id}`,
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenMenuFor(
                                          openMenuFor() === `wt:${w.id}` ? null : `wt:${w.id}`,
                                        );
                                      }}
                                      aria-label={`More actions for worktree ${w.branch}`}
                                      aria-haspopup="menu"
                                      aria-expanded={openMenuFor() === `wt:${w.id}`}
                                      title="More actions"
                                      data-testid={`project-menu-wt-${w.id}`}
                                    >
                                      <KebabIcon />
                                    </button>
                                    <Show when={openMenuFor() === `wt:${w.id}`}>
                                      <div
                                        role="menu"
                                        class="absolute right-0 top-full mt-1 z-30 min-w-[160px] py-1 rounded-lg border border-border bg-bg-1 shadow-xl text-[12.5px]"
                                        onClick={(e) => e.stopPropagation()}
                                        data-testid={`project-menu-list-wt-${w.id}`}
                                      >
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                          onClick={() => {
                                            setOpenMenuFor(null);
                                            openNewChatDialog(p.id, w.id, w.branch);
                                          }}
                                          data-testid={`new-chat-wt-${w.id}`}
                                        >
                                          <ChatPlusIcon /> New chat
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                          onClick={() => {
                                            setOpenMenuFor(null);
                                            void openTerminalAt(p.id, w.id, w.branch);
                                          }}
                                          data-testid={`new-terminal-wt-${w.id}`}
                                        >
                                          <TerminalPlusIcon /> New terminal
                                        </button>
                                        <div class="my-1 border-t border-border" />
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                          onClick={() => {
                                            setOpenMenuFor(null);
                                            setChangesScope({ path: w.path, label: w.branch });
                                          }}
                                          data-testid={`changes-wt-${w.id}`}
                                        >
                                          <DiffIcon /> View changes
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                          onClick={() => {
                                            setOpenMenuFor(null);
                                            setRenameFor({
                                              projectId: p.id,
                                              worktreeId: w.id,
                                              currentBranch: w.branch,
                                            });
                                          }}
                                          data-testid={`rename-wt-${w.id}`}
                                        >
                                          <PencilIcon /> Rename
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-2"
                                          onClick={() => {
                                            setOpenMenuFor(null);
                                            setChatHistoryFor({
                                              projectId: p.id,
                                              worktreeId: w.id,
                                            });
                                          }}
                                          data-testid={`chat-history-wt-${w.id}`}
                                        >
                                          <HistoryIcon /> Chat history
                                        </button>
                                        <div class="my-1 border-t border-border" />
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class="w-full text-left px-3 py-1.5 flex items-center gap-2 text-danger hover:bg-bg-2"
                                          onClick={(e) => {
                                            setOpenMenuFor(null);
                                            deleteWorktree(p.id, w.id, e);
                                          }}
                                          data-testid={`remove-wt-${w.id}`}
                                        >
                                          <XIcon /> Remove worktree
                                        </button>
                                      </div>
                                    </Show>
                                  </div>
                                </div>

                                {/* Inline file tree rooted at the
                                    worktree's path. Hidden when the
                                    rail's Files toggle is off. */}
                                <Show when={wtOpen() && showFiles()}>
                                  <DirNode path={w.path} depth={2} initiallyOpen />
                                </Show>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </div>
                  </Show>

                  {/* Helper hint when project is a git repo without a remote.
                      Indented to align under the project name so it reads as a
                      message for THIS project row, not the whole rail. */}
                  <Show when={open() && p.is_git && !p.has_remote && !isWorktree}>
                    <p class="pl-7 pr-2 mt-1 text-[0.73em] text-fg-subtle italic">
                      Add a git remote to <span class="font-medium">{p.name}</span> to enable
                      worktrees.
                    </p>
                  </Show>

                  {/* Inline file tree for the project (when expanded).
                      Hidden when the rail's Files toggle is off. */}
                  <Show when={open() && showFiles()}>
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

      <Show when={chatHistoryFor()} keyed>
        {(ctx) => (
          <ChatHistoryDialog
            projectId={ctx.projectId}
            worktreeId={ctx.worktreeId}
            onClose={() => setChatHistoryFor(null)}
          />
        )}
      </Show>

      <Show when={renameFor()} keyed>
        {(target) => (
          <RenameWorktreeDialog
            projectId={target.projectId}
            worktreeId={target.worktreeId}
            currentBranch={target.currentBranch}
            onCancel={() => setRenameFor(null)}
            onRenamed={() => {
              setRenameFor(null);
              void refreshWorktreesForProject(target.projectId);
            }}
          />
        )}
      </Show>

      <Show when={settingsFor()} keyed>
        {(project) => (
          <ProjectSettingsDialog
            project={project}
            onCancel={() => setSettingsFor(null)}
            onSaved={(updated) => {
              // Reflect the new pre_worktree_script into the projects
              // store so subsequent WorktreeDialog opens read the
              // fresh value. The dialog closes itself right after
              // (via its own onCancel call) so we don't need to flip
              // settingsFor here.
              const idx = state.projects.findIndex((p) => p.id === updated.id);
              if (idx >= 0) {
                setState("projects", idx, updated);
              }
            }}
          />
        )}
      </Show>

      <Show when={newChatFor()} keyed>
        {(ctx) => (
          <NewChatDialog
            projectId={ctx.projectId}
            worktreeId={ctx.worktreeId}
            defaultTitle={`chat in ${ctx.parentName}`}
            onCancel={() => setNewChatFor(null)}
            onCreated={(chat) => {
              addChatTab({ id: chat.id, title: chat.title });
              setNewChatFor(null);
            }}
          />
        )}
      </Show>
    </aside>
  );
}

/** Pulsing accent dot shown on a project/worktree row when a chat
 *  under it has an in-flight agent turn. Mirrors the per-tab busy dot
 *  in TabStrip so "something is working here" reads the same way in
 *  both places. */
function WorkingDot(props: { title: string }) {
  return (
    <span
      class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0"
      title={props.title}
      data-testid="rail-working-dot"
      aria-label="Working"
    />
  );
}

function Logo() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

/** Lucide-style folder-tree glyph, used when inline file/folder
 *  rendering is ON. Em-sized so it scales with --ag-font-size. */
function FilesOnIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a1 1 0 0 1 1-1h4l2 2h5a1 1 0 0 1 1 1v3"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
      <path
        d="M14 14a1 1 0 0 1 1-1h2l1 1h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-4Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
      <path
        d="M3 11v8a1 1 0 0 0 1 1h6"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** Folder-tree glyph with a diagonal strike, used when inline
 *  file/folder rendering is OFF (worktrees-only view). */
function FilesOffIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a1 1 0 0 1 1-1h4l2 2h5a1 1 0 0 1 1 1v3"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
      <path
        d="M14 14a1 1 0 0 1 1-1h2l1 1h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-4Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
      <path
        d="M3 11v8a1 1 0 0 0 1 1h6"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
      />
      <path d="M4 20 20 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="0.85em" height="0.85em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}

function PencilIcon() {
  // Lucide-style pencil. Sized in em so it scales with --ag-font-size.
  return (
    <svg width="0.85em" height="0.85em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  // Lucide-style settings cog. Em-sized to track the UI font.
  return (
    <svg width="0.9em" height="0.9em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.43.16.78.46 1 .85L20.91 10H21a2 2 0 1 1 0 4h-.09c-.39.22-.69.57-.85 1Z"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="1em"
      height="1em"
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
/** Lucide `git-branch`: vertical trunk with a branch splitting off
 *  to the right — the standard "this is a worktree / branch" glyph. */
function WorktreeIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="text-accent shrink-0"
      aria-hidden="true"
    >
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** Lucide `git-branch-plus`: classic vertical line with a fork
 *  branching to the right and a `+` glyph at the branch tip. Used as
 *  the inline "+ worktree" action on the project row. */
function BranchPlusIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="shrink-0"
      aria-hidden="true"
    >
      <path d="M6 3v12" />
      <path d="M18 9a3 3 0 1 0-3 3" />
      <path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M15 6h6" />
      <path d="M18 3v6" />
    </svg>
  );
}

/** Lucide `git-compare-arrows`: two arrows pointing in opposite
 *  directions between two endpoints — clearly reads as "compare /
 *  diff". Used as the inline "View changes" action. */
function DiffIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="shrink-0"
      aria-hidden="true"
    >
      <circle cx="5" cy="6" r="3" />
      <path d="M12 6h5a2 2 0 0 1 2 2v7" />
      <path d="m15 9-3-3 3-3" />
      <circle cx="19" cy="18" r="3" />
      <path d="M12 18H7a2 2 0 0 1-2-2V9" />
      <path d="m9 15 3 3-3 3" />
    </svg>
  );
}

function HistoryIcon() {
  // Clock with arrow — represents "history / restore".
  return (
    <svg
      width="1em"
      height="1em"
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
      <path
        d="M3 4v5h5"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
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
      width="1em"
      height="1em"
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
      <path d="M19 13v6M16 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  );
}

function TerminalPlusIcon() {
  // Terminal window outline + chevron prompt + small `+` in the
  // top-right corner. Visually parallel to ChatPlusIcon so the row
  // reads as "create one of these here".
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      class="shrink-0"
      aria-hidden="true"
    >
      {/* window frame */}
      <rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.6" />
      {/* prompt chevron + cursor underscore inside the window */}
      <path
        d="M6 9l2.5 2L6 13"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M10.5 14h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      {/* `+` glyph in the corner */}
      <path d="M19 13v6M16 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
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
            fallback={<FileRow path={entry.path} name={entry.name} depth={props.depth} />}
          >
            <FolderRow path={entry.path} name={entry.name} depth={props.depth} />
          </Show>
        )}
      </For>
      <Show when={open() && entries.loading}>
        <li
          class="px-2 py-1 text-[0.77em] text-fg-subtle"
          style={{ "padding-left": `${8 + props.depth * 12}px` }}
        >
          loading…
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
        <span class="truncate text-[0.83em]">{props.name}</span>
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
        <span class="truncate text-[0.83em]">{props.name}</span>
      </button>
    </li>
  );
}

function Chevron(props: { open: boolean }) {
  return (
    <svg
      width="0.72em"
      height="0.72em"
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
      width="0.92em"
      height="0.92em"
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
      width="0.92em"
      height="0.92em"
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
