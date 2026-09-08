import { For, Show, createSignal, onMount } from "solid-js";
import { api } from "../api/client";

interface Props {
  projectId: string;
  onClose: () => void;
  onSwitched: () => void;
}

/** Change the main repo's checked-out branch. Lists local branches
 *  (with the current one marked) and switches on click. A free-form
 *  field allows creating + switching to a new branch off HEAD. */
export default function SwitchBranchDialog(props: Props) {
  const [branches, setBranches] = createSignal<{ name: string; current: boolean }[]>([]);
  const [filter, setFilter] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  onMount(() => {
    void api
      .listBranches(props.projectId)
      .then((b) => setBranches(b))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  });

  const filtered = () => {
    const q = filter().trim().toLowerCase();
    const list = branches();
    return q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list;
  };

  // The typed filter names a branch that doesn't exist yet → offer to
  // create it off HEAD.
  const createTarget = () => {
    const q = filter().trim();
    if (!q) return null;
    return branches().some((b) => b.name === q) ? null : q;
  };

  async function doSwitch(branch: string, create: boolean) {
    if (busy()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.switchBranch(props.projectId, branch, create);
      props.onSwitched();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Change branch"
      data-testid="switch-branch-dialog"
    >
      <div class="absolute inset-0 bg-black/60" onClick={() => !busy() && props.onClose()} />
      <div class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 p-5 shadow-2xl">
        <h3 class="text-[15px] font-semibold mb-1">Change branch</h3>
        <p class="text-[12.5px] text-fg-muted mb-4">
          Switch the main repo to a different branch. Uncommitted changes may block the switch.
        </p>

        <input
          class="ag-input font-mono mb-3"
          placeholder="Filter or type a new branch name…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          data-testid="switch-branch-filter"
          autofocus
        />

        <Show when={err()}>
          <p class="mb-3 text-[12px] text-danger" data-testid="switch-branch-error">
            {err()}
          </p>
        </Show>

        <div class="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
          <Show
            when={!loading()}
            fallback={<p class="px-3 py-4 text-[12.5px] text-fg-subtle">Loading branches…</p>}
          >
            <Show when={createTarget()}>
              <button
                type="button"
                class="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-2 disabled:opacity-50"
                disabled={busy()}
                onClick={() => void doSwitch(createTarget()!, true)}
                data-testid="switch-branch-create"
              >
                <span class="text-accent">＋</span>
                <span class="font-mono text-[12.5px]">
                  Create <span class="font-semibold">{createTarget()}</span> off HEAD
                </span>
              </button>
            </Show>
            <For
              each={filtered()}
              fallback={
                <Show when={!createTarget()}>
                  <p class="px-3 py-4 text-[12.5px] text-fg-subtle">No matching branches.</p>
                </Show>
              }
            >
              {(b) => (
                <button
                  type="button"
                  class="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-2 disabled:opacity-50"
                  disabled={busy() || b.current}
                  onClick={() => void doSwitch(b.name, false)}
                  data-testid={`switch-branch-item-${b.name}`}
                >
                  <span
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    classList={{ "bg-accent": b.current, "bg-transparent": !b.current }}
                  />
                  <span class="font-mono text-[12.5px] truncate">{b.name}</span>
                  <Show when={b.current}>
                    <span class="ml-auto text-[10.5px] text-fg-subtle uppercase tracking-wider">
                      current
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>

        <div class="flex justify-end gap-2 mt-4">
          <button
            type="button"
            class="ag-btn ag-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
