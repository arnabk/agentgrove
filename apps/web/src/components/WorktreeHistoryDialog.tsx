import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import { api, type Worktree } from "../api/client";
import { alert as themedAlert, confirm } from "./dialog";

interface Props {
  /** Optional: restrict history to a single project. When `null` /
   *  undefined, all projects are shown. */
  projectId?: string | null;
  onClose: () => void;
  /** Called after a successful restore so the caller can refresh its
   *  live worktree list (and rail). */
  onRestored?: ((worktree: Worktree) => void) | undefined;
}

/**
 * Modal dialog showing the history of soft-deleted worktrees with a
 * branch substring search and a per-row Restore button.
 *
 * Restore only re-activates the database row; the git worktree on disk
 * is not re-created. We surface that constraint inline so users aren't
 * surprised.
 */
export default function WorktreeHistoryDialog(props: Props) {
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<Worktree[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [busyId, setBusyId] = createSignal<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const params: { q?: string; projectId?: string } = {};
      const q = query().trim();
      if (q) params.q = q;
      if (props.projectId) params.projectId = props.projectId;
      const list = await api.listWorktreeHistory(params);
      setItems(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(() => void refresh());

  // Debounced re-fetch on search input.
  let timer: number | undefined;
  createEffect(() => {
    void query();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 200);
  });

  async function doRestore(w: Worktree) {
    const ok = await confirm({
      title: `Restore "${w.branch}"?`,
      body: "AgentGrove will restore the database record only. The git worktree directory on disk is not re-created; if you need a functioning worktree, create a new one from this branch.",
      confirmLabel: "Restore",
      testId: "confirm-restore-worktree",
    });
    if (!ok) return;
    setBusyId(w.id);
    try {
      const restored = await api.restoreWorktree(w.id);
      props.onRestored?.(restored);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await themedAlert({
        title: "Restore failed",
        body: msg,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="worktree-history-dialog"
    >
      <div class="absolute inset-0 bg-black/60" onClick={() => props.onClose()} />
      <div class="relative w-full max-w-2xl rounded-xl border border-border bg-bg-1 p-6 shadow-2xl flex flex-col max-h-[80vh]">
        <div class="flex items-center justify-between mb-1">
          <h3 class="text-[15px] font-semibold">Worktree history</h3>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => props.onClose()}
            data-testid="history-close"
            aria-label="Close worktree history"
          >
            ✕
          </button>
        </div>
        <p class="text-[12.5px] text-fg-muted mb-4">
          Soft-deleted worktrees stay here so you can recover a branch name or restore the record.
          Restoring does not re-create the worktree on disk.
        </p>

        <input
          class="ag-input mb-3"
          placeholder="Search by branch name…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          data-testid="history-search"
          autofocus
        />

        <Show when={err()}>
          <p class="mb-3 text-[12px] text-danger" data-testid="history-error">
            {err()}
          </p>
        </Show>

        <div class="flex-1 overflow-y-auto -mx-2 px-2">
          <Show
            when={!loading() && items().length === 0}
            fallback={
              <Show when={loading()}>
                <p class="text-center text-[12.5px] text-fg-subtle py-6">Loading…</p>
              </Show>
            }
          >
            <p class="text-center text-[12.5px] text-fg-subtle py-6" data-testid="history-empty">
              No removed worktrees match.
            </p>
          </Show>

          <ul class="divide-y divide-border">
            <For each={items()}>
              {(w) => (
                <li class="flex items-center gap-3 py-2.5" data-testid={`history-row-${w.id}`}>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-mono text-[12.5px] truncate">{w.branch}</span>
                      <span class="ag-chip text-[10px]">{w.base_ref}</span>
                    </div>
                    <div class="text-[11px] text-fg-subtle truncate" title={w.path}>
                      {w.path}
                    </div>
                    <Show when={w.removed_at}>
                      <div class="text-[10.5px] text-fg-subtle">
                        removed {new Date(w.removed_at!).toLocaleString()}
                      </div>
                    </Show>
                  </div>
                  <button
                    class="ag-btn ag-btn-ghost ag-btn-sm"
                    onClick={() => void doRestore(w)}
                    disabled={busyId() === w.id}
                    data-testid={`history-restore-${w.id}`}
                    title="Restore this worktree record"
                  >
                    {busyId() === w.id ? "Restoring…" : "↺ Restore"}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
    </div>
  );
}
