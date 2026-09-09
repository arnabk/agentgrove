import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import { api, type BranchRow } from "../api/client";

/**
 * Branch Center — an overlay listing local branches across all
 * projects, with a search box. Sibling of the PR Center. Read-only:
 * search + scan. Checkout/switch stays on the project menu's
 * "Change branch" flow (which is per-repo and needs a clean tree).
 */
export default function BranchCenterDialog(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [branches, { refetch }] = createResource<BranchRow[]>(() => api.listAllBranches());

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = branches() ?? [];
    if (!q) return list;
    return list.filter((b) =>
      [b.name, b.project_name, b.subject ?? "", b.upstream ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function ageLabel(committed: string | null): { text: string; cls: string } {
    if (!committed) return { text: "", cls: "text-fg-subtle" };
    const days = Math.floor((Date.now() - new Date(committed).getTime()) / 86_400_000);
    const text = days <= 0 ? "today" : days === 1 ? "1d" : `${days}d`;
    const cls = days < 7 ? "text-success" : days < 30 ? "text-warning" : "text-fg-subtle";
    return { text, cls };
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Branches"
      data-testid="branch-center"
    >
      <div class="absolute inset-0 bg-black/60" onClick={() => props.onClose()} />
      <div
        class="relative bg-bg-1 border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{
          width: "calc(80vw * var(--ag-zoom-inv, 1))",
          "max-width": "1100px",
          height: "calc(82vh * var(--ag-zoom-inv, 1))",
        }}
      >
        <header class="min-h-12 shrink-0 px-4 py-2 flex items-center gap-3 border-b border-border">
          <span class="text-lg">⑂</span>
          <h2 class="text-[14px] font-semibold tracking-tight shrink-0">Branches</h2>
          <input
            class="ag-input flex-1 min-w-0 !py-1.5"
            placeholder="Search by branch, repo, commit subject, upstream…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            data-testid="branch-search"
            autofocus
          />
          <span class="ag-chip font-mono text-fg-subtle" data-testid="branch-count">
            {filtered().length}
            <Show when={query().trim()}>/{(branches() ?? []).length}</Show>
          </span>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => void refetch()}
            disabled={branches.loading}
            title="Refresh"
            data-testid="branch-refresh"
          >
            ↻
          </button>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => props.onClose()}
            aria-label="Close branches"
            data-testid="branch-close"
          >
            ✕
          </button>
        </header>

        <div class="flex-1 overflow-y-auto">
          <Show
            when={!branches.loading}
            fallback={
              <p class="text-center text-[12.5px] text-fg-subtle py-10">Loading branches…</p>
            }
          >
            <Show
              when={filtered().length > 0}
              fallback={
                <p
                  class="text-center text-[12.5px] text-fg-subtle py-10"
                  data-testid="branch-empty"
                >
                  <Show when={(branches() ?? []).length === 0} fallback="No branches match.">
                    No branches found.
                  </Show>
                </p>
              }
            >
              <ul class="divide-y divide-border">
                <For each={filtered()}>
                  {(b) => {
                    const age = ageLabel(b.committed_at);
                    return (
                      <li
                        class="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-2 transition-colors"
                        data-testid={`branch-row-${b.project_id}-${b.name}`}
                      >
                        <span
                          class="ag-chip ag-chip-accent shrink-0 max-w-[160px] truncate"
                          title={b.project_name}
                        >
                          {b.project_name}
                        </span>
                        <span
                          class="font-mono text-[12.5px] shrink-0 max-w-[280px] truncate"
                          classList={{ "text-accent font-semibold": b.current }}
                          title={b.name}
                        >
                          {b.name}
                        </span>
                        <Show when={b.current}>
                          <span class="ag-chip !text-[10px] text-success shrink-0">current</span>
                        </Show>
                        <Show when={b.upstream}>
                          <span
                            class="text-[11px] text-fg-subtle font-mono shrink-0 hidden md:inline"
                            title={`Tracks ${b.upstream}`}
                          >
                            ⤴ {b.upstream}
                          </span>
                        </Show>
                        <span class="flex-1 min-w-0 truncate text-[12px] text-fg-muted">
                          {b.subject ?? ""}
                        </span>
                        <span
                          class={`text-[11.5px] font-mono shrink-0 w-12 text-right ${age.cls}`}
                          title={b.committed_at ?? ""}
                        >
                          {age.text}
                        </span>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
