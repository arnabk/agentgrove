import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import { api, type PrRow } from "../api/client";

/**
 * PR Center — an overlay listing every open PR/MR across all projects,
 * with a search box. Data comes from `GET /api/prs`, which fans out to
 * the forge CLIs (gh/glab) per project. Read-only v1: search + open in
 * the browser. Merge/checkout live on the worktree rail already.
 */
export default function PrCenterDialog(props: {
  onClose: () => void;
  /** When set, show only PRs for this project. */
  projectId?: string;
  projectName?: string;
}) {
  const [query, setQuery] = createSignal("");
  const [prs, { refetch }] = createResource<PrRow[]>(() => api.listAllPrs());

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    let list = prs() ?? [];
    // Scope to a single project when opened from its menu.
    if (props.projectId) list = list.filter((p) => p.project_id === props.projectId);
    if (!q) return list;
    return list.filter((p) =>
      [p.title, p.project_name, p.branch, p.author ?? "", `#${p.number}`, p.source]
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

  function ageLabel(created: string | null): { text: string; cls: string } {
    if (!created) return { text: "", cls: "text-fg-subtle" };
    const days = Math.floor((Date.now() - new Date(created).getTime()) / 86_400_000);
    const text = days <= 0 ? "today" : days === 1 ? "1d" : `${days}d`;
    // fresh <2d, stale <7d, ancient older.
    const cls = days < 2 ? "text-success" : days < 7 ? "text-warning" : "text-danger";
    return { text, cls };
  }

  function checkGlyph(status: string | null): { g: string; cls: string; title: string } | null {
    switch (status) {
      case "success":
        return { g: "✓", cls: "text-success", title: "Checks passing" };
      case "failure":
        return { g: "✗", cls: "text-danger", title: "Checks failing" };
      case "pending":
        return { g: "◷", cls: "text-warning", title: "Checks running" };
      default:
        return null;
    }
  }

  function reviewLabel(d: string | null): { text: string; cls: string } | null {
    switch (d) {
      case "approved":
        return { text: "approved", cls: "text-success" };
      case "changes_requested":
        return { text: "changes", cls: "text-danger" };
      case "review_required":
        return { text: "review", cls: "text-warning" };
      default:
        return null;
    }
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pull requests"
      data-testid="pr-center"
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
          <span class="text-lg">⇄</span>
          <h2 class="text-[14px] font-semibold tracking-tight shrink-0">
            Pull Requests{props.projectName ? ` — ${props.projectName}` : ""}
          </h2>
          <input
            class="ag-input flex-1 min-w-0 !py-1.5"
            placeholder="Search by title, repo, branch, author, #number…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            data-testid="pr-search"
            autofocus
          />
          <span class="ag-chip font-mono text-fg-subtle" data-testid="pr-count">
            {filtered().length}
            <Show when={query().trim()}>/{(prs() ?? []).length}</Show>
          </span>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => void refetch()}
            disabled={prs.loading}
            title="Refresh"
            data-testid="pr-refresh"
          >
            ↻
          </button>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => props.onClose()}
            aria-label="Close pull requests"
            data-testid="pr-close"
          >
            ✕
          </button>
        </header>

        <div class="flex-1 overflow-y-auto">
          <Show
            when={!prs.loading}
            fallback={<p class="text-center text-[12.5px] text-fg-subtle py-10">Loading PRs…</p>}
          >
            <Show
              when={filtered().length > 0}
              fallback={
                <p class="text-center text-[12.5px] text-fg-subtle py-10" data-testid="pr-empty">
                  <Show when={(prs() ?? []).length === 0} fallback="No PRs match your search.">
                    No open PRs found. This lists PRs/MRs from projects with the{" "}
                    <code class="font-mono">gh</code> / <code class="font-mono">glab</code> CLI
                    installed and authenticated.
                  </Show>
                </p>
              }
            >
              <ul class="divide-y divide-border">
                <For each={filtered()}>
                  {(pr) => {
                    const age = ageLabel(pr.created_at);
                    const check = checkGlyph(pr.checks_status);
                    const review = reviewLabel(pr.review_decision);
                    return (
                      <li>
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-2 transition-colors"
                          data-testid={`pr-row-${pr.project_id}-${pr.number}`}
                        >
                          <span
                            class="ag-chip ag-chip-accent shrink-0 max-w-[160px] truncate"
                            title={pr.project_name}
                          >
                            {pr.project_name}
                          </span>
                          <span class="font-mono text-fg-subtle text-[12px] shrink-0">
                            #{pr.number}
                          </span>
                          <span class="flex-1 min-w-0 truncate text-[13px]">
                            <Show when={pr.draft}>
                              <span class="ag-chip !text-[10px] mr-1.5 text-fg-subtle">draft</span>
                            </Show>
                            {pr.title}
                          </span>
                          <Show when={pr.author}>
                            <span class="text-[11.5px] text-fg-subtle shrink-0 hidden sm:inline">
                              @{pr.author}
                            </span>
                          </Show>
                          <Show when={review}>
                            <span class={`text-[11px] shrink-0 ${review!.cls}`}>
                              {review!.text}
                            </span>
                          </Show>
                          <Show when={check}>
                            <span class={`shrink-0 ${check!.cls}`} title={check!.title}>
                              {check!.g}
                            </span>
                          </Show>
                          <span
                            class={`text-[11.5px] font-mono shrink-0 w-12 text-right ${age.cls}`}
                          >
                            {age.text}
                          </span>
                        </a>
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
