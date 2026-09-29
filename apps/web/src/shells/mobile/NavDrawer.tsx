import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { api, type Project, type Worktree } from "@/core/api/client";
import {
  currentWorktreeId,
  isScopeCompleted,
  isScopeWorking,
  refreshWorktreesForProject,
  selectWorktree,
  state,
} from "@/core/stores/app";
import { confirm } from "@/ui/dialog";
import { pushToast } from "@/ui/Toast";
import RenameWorktreeDialog from "@/features/projects/RenameWorktreeDialog";
import WorktreeDialog from "@/features/projects/WorktreeDialog";
import { setDrawerOpen } from "@/shells/mobile/store";
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/shells/mobile/icons";

/**
 * Slide-over navigation: projects, and the worktrees under each.
 * Picking a row sets the active scope and closes the drawer, which is
 * the only navigation gesture the mobile shell needs — everything else
 * is reachable from the bottom tabs.
 *
 * Worktrees are read-write here (create / rename / delete), reusing the
 * same dialogs the desktop rail uses. Adding or removing *projects* is
 * deliberately desktop-only: it means browsing the server's filesystem,
 * which is not a phone task.
 */
export default function NavDrawer(props: { onClose: () => void }) {
  const [expanded, setExpanded] = createSignal<Record<string, true>>({});
  const [newWorktreeFor, setNewWorktreeFor] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<{
    projectId: string;
    worktreeId: string;
    branch: string;
  } | null>(null);
  const [busyWorktree, setBusyWorktree] = createSignal<string | null>(null);

  const isOpen = (pid: string) => expanded()[pid] === true;

  function toggle(pid: string) {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[pid]) delete next[pid];
      else next[pid] = true;
      return next;
    });
    if (!state.worktrees[pid]) void refreshWorktreesForProject(pid);
  }

  // Auto-expand and hydrate the project the user is already scoped to,
  // so opening the drawer shows where they are rather than a flat list.
  onMount(() => {
    const pid = state.selectedProjectId;
    if (!pid) return;
    setExpanded((prev) => ({ ...prev, [pid]: true }));
    if (!state.worktrees[pid]) void refreshWorktreesForProject(pid);
  });

  // Close on Escape (Bluetooth keyboards and tablet users exist).
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  function pick(projectId: string, worktreeId: string | null) {
    selectWorktree(projectId, worktreeId);
    setDrawerOpen(false);
  }

  async function removeWorktree(p: Project, w: Worktree) {
    const ok = await confirm({
      title: "Remove worktree",
      body: `Remove ${w.branch}? The worktree directory is deleted; the branch is kept.`,
      confirmLabel: "Remove",
      danger: true,
      testId: "confirm-remove-worktree-mobile",
    });
    if (!ok) return;
    setBusyWorktree(w.id);
    try {
      await api.deleteWorktree(p.id, w.id);
      await refreshWorktreesForProject(p.id);
      // Removing the scope you were in would leave the shell pointing
      // at a worktree that no longer exists.
      if (currentWorktreeId() === w.id) selectWorktree(p.id, null);
    } catch (e) {
      pushToast({
        title: "Could not remove worktree",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyWorktree(null);
    }
  }

  return (
    <>
      <div
        class="fixed inset-0 z-40 bg-black/60"
        onClick={props.onClose}
        data-testid="mobile-drawer-backdrop"
      />
      <aside
        class="fixed inset-y-0 left-0 z-50 flex w-[86%] max-w-[340px] flex-col bg-bg-1 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Projects"
        data-testid="mobile-drawer"
      >
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <span class="text-[14px] font-semibold tracking-tight">Projects</span>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-icon"
            onClick={props.onClose}
            aria-label="Close projects"
            data-testid="mobile-drawer-close"
          >
            <CloseIcon />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3">
          <Show
            when={state.projects.length > 0}
            fallback={
              <p class="px-3 py-6 text-center text-[13px] leading-relaxed text-fg-subtle">
                No projects yet. Add one from the desktop app — it needs to browse the server's
                filesystem.
              </p>
            }
          >
            <ul class="space-y-1" data-testid="mobile-project-list">
              <For each={state.projects}>
                {(p) => {
                  const atRoot = () =>
                    state.selectedProjectId === p.id && currentWorktreeId() === null;
                  const worktrees = () => state.worktrees[p.id] ?? [];
                  return (
                    <li>
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          class="flex min-h-11 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px]"
                          classList={{
                            "bg-accent-soft text-accent": atRoot(),
                            "active:bg-bg-3": !atRoot(),
                          }}
                          onClick={() => pick(p.id, null)}
                          data-testid={`mobile-project-${p.id}`}
                        >
                          <span class="shrink-0 text-fg-subtle">
                            <FolderIcon size={16} />
                          </span>
                          <span class="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                          <Show when={isScopeWorking(p.id, null)}>
                            <span
                              class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent"
                              title="Agent is working"
                              data-testid={`mobile-working-${p.id}`}
                            />
                          </Show>
                          <Show when={!isScopeWorking(p.id, null) && isScopeCompleted(p.id, null)}>
                            <span
                              class="h-2 w-2 shrink-0 rounded-full bg-accent"
                              title="A chat here finished"
                            />
                          </Show>
                        </button>
                        <button
                          type="button"
                          class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-9 shrink-0"
                          onClick={() => toggle(p.id)}
                          aria-expanded={isOpen(p.id)}
                          aria-label={isOpen(p.id) ? "Hide worktrees" : "Show worktrees"}
                          data-testid={`mobile-toggle-${p.id}`}
                        >
                          <ChevronIcon size={16} open={isOpen(p.id)} />
                        </button>
                      </div>

                      <Show when={isOpen(p.id)}>
                        <ul
                          class="mt-0.5 space-y-0.5 pl-4"
                          data-testid={`mobile-worktrees-${p.id}`}
                        >
                          <For each={worktrees()}>
                            {(w) => {
                              const active = () =>
                                state.selectedProjectId === p.id && currentWorktreeId() === w.id;
                              const pending = () =>
                                w.status === "creating" || w.status === "pre_script";
                              return (
                                <li class="flex items-center gap-1">
                                  <button
                                    type="button"
                                    class="flex min-h-11 flex-1 items-center gap-2 rounded-lg px-2.5 text-left text-[13px]"
                                    classList={{
                                      "bg-accent-soft text-accent": active(),
                                      "active:bg-bg-3": !active(),
                                      "opacity-60": pending(),
                                    }}
                                    disabled={pending()}
                                    onClick={() => pick(p.id, w.id)}
                                    data-testid={`mobile-worktree-${w.id}`}
                                  >
                                    <span class="shrink-0 text-fg-subtle">
                                      <BranchIcon size={15} />
                                    </span>
                                    <span class="min-w-0 flex-1 truncate">{w.branch}</span>
                                    <Show when={pending()}>
                                      <span class="shrink-0 text-[10px] text-fg-subtle">
                                        {w.status === "creating" ? "creating…" : "setup…"}
                                      </span>
                                    </Show>
                                    <Show when={isScopeWorking(p.id, w.id)}>
                                      <span
                                        class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent"
                                        title="Agent is working"
                                      />
                                    </Show>
                                  </button>
                                  <button
                                    type="button"
                                    class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-8 shrink-0 text-fg-subtle"
                                    onClick={() =>
                                      setRenaming({
                                        projectId: p.id,
                                        worktreeId: w.id,
                                        branch: w.branch,
                                      })
                                    }
                                    aria-label={`Rename ${w.branch}`}
                                    data-testid={`mobile-rename-worktree-${w.id}`}
                                  >
                                    <PencilIcon size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-8 shrink-0 text-fg-subtle"
                                    disabled={busyWorktree() === w.id}
                                    onClick={() => void removeWorktree(p, w)}
                                    aria-label={`Remove ${w.branch}`}
                                    data-testid={`mobile-remove-worktree-${w.id}`}
                                  >
                                    <TrashIcon size={14} />
                                  </button>
                                </li>
                              );
                            }}
                          </For>

                          <li>
                            <button
                              type="button"
                              class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-fg-subtle active:bg-bg-3"
                              onClick={() => setNewWorktreeFor(p.id)}
                              data-testid={`mobile-new-worktree-${p.id}`}
                            >
                              <PlusIcon size={15} />
                              New worktree
                            </button>
                          </li>
                        </ul>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
      </aside>

      <Show when={newWorktreeFor()}>
        {(pid) => (
          <WorktreeDialog
            projectId={pid()}
            onCancel={() => setNewWorktreeFor(null)}
            onCreated={(worktreeId) => {
              const projectId = pid();
              setNewWorktreeFor(null);
              void refreshWorktreesForProject(projectId);
              if (worktreeId) pick(projectId, worktreeId);
            }}
          />
        )}
      </Show>

      <Show when={renaming()}>
        {(r) => (
          <RenameWorktreeDialog
            projectId={r().projectId}
            worktreeId={r().worktreeId}
            currentBranch={r().branch}
            onCancel={() => setRenaming(null)}
            onRenamed={() => {
              const projectId = r().projectId;
              setRenaming(null);
              void refreshWorktreesForProject(projectId);
            }}
          />
        )}
      </Show>
    </>
  );
}
