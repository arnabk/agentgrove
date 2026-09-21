import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { api, type TicketRow } from "../api/client";
import { pushToast } from "./Toast";
import { state } from "../stores/app";

/** Left-rail ClickUp view: lists the authenticated user's ClickUp tasks
 *  (workspace-level, not repo-scoped). Each row opens in the browser,
 *  offers copy link / id, and a "Work on this" action that picks a
 *  project to create the worktree in. Mirrors {@link DbSidebar}'s
 *  fill-the-rail panel pattern. */
export default function ClickUpPanel() {
  const [query, setQuery] = createSignal("");
  const [working, setWorking] = createSignal<string | null>(null);
  const [pickFor, setPickFor] = createSignal<string | null>(null);
  const [tasks, { refetch }] = createResource<TicketRow[]>(() => api.listClickUpTasks());

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = tasks() ?? [];
    if (!q) return list;
    return list.filter((t) =>
      [t.title, t.id, t.status, t.assignee ?? "", t.priority ?? "", t.labels.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  });

  function statusClass(status: string): string {
    const s = status.toLowerCase();
    if (s === "open" || s === "to do" || s === "todo") return "ag-chip-success";
    if (s === "in_progress" || s === "in progress" || s === "doing") return "ag-chip-warn";
    if (s === "closed" || s === "done" || s === "complete") return "text-fg-subtle";
    return "";
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ title: `${what} copied`, message: text, level: "info" });
    } catch (e) {
      pushToast({
        title: "Copy failed",
        message: e instanceof Error ? e.message : String(e),
        level: "error",
      });
    }
  }

  async function work(taskId: string, projectId: string) {
    if (working()) return;
    setWorking(taskId);
    setPickFor(null);
    try {
      await api.workOnClickUpTask(taskId, projectId);
      pushToast({
        title: "Worktree created",
        message: taskId,
        level: "info",
      });
    } catch (e) {
      pushToast({
        title: "Could not create worktree",
        message: e instanceof Error ? e.message : String(e),
        level: "error",
      });
    } finally {
      setWorking(null);
    }
  }

  return (
    <div class="flex-1 flex flex-col min-h-0" data-testid="clickup-panel">
      <div class="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <span class="text-[0.8em] font-semibold uppercase tracking-wider text-fg-subtle">
          ClickUp
        </span>
        <div class="flex items-center gap-1.5">
          <span class="ag-chip font-mono text-fg-subtle" data-testid="clickup-count">
            {filtered().length}
            <Show when={query().trim()}>/{(tasks() ?? []).length}</Show>
          </span>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={() => void refetch()}
            disabled={tasks.loading}
            title="Refresh"
            data-testid="clickup-refresh"
          >
            ↻
          </button>
        </div>
      </div>

      <div class="p-2 border-b border-border">
        <input
          class="ag-input w-full"
          placeholder="Search tasks…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          data-testid="clickup-search"
        />
      </div>

      <div class="flex-1 overflow-auto">
        <Show
          when={!tasks.loading}
          fallback={<div class="text-fg-subtle text-[11px] px-3 py-4">Loading tasks…</div>}
        >
          <Show
            when={!tasks.error}
            fallback={
              <div class="text-danger text-[11px] px-3 py-4" data-testid="clickup-error">
                Failed to load tasks:{" "}
                {tasks.error instanceof Error ? tasks.error.message : String(tasks.error)}
              </div>
            }
          >
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="text-fg-subtle text-[11px] px-3 py-4" data-testid="clickup-empty">
                  <Show
                    when={(tasks() ?? []).length === 0 && !query().trim()}
                    fallback="No tasks match your search."
                  >
                    Connect ClickUp in Settings → Integrations.
                  </Show>
                </div>
              }
            >
              <ul class="divide-y divide-border">
                <For each={filtered()}>
                  {(t) => (
                    <li class="group relative">
                      <div
                        class="flex flex-col gap-1 px-3 py-2 hover:bg-bg-3 cursor-pointer"
                        onClick={() => window.open(t.url, "_blank", "noopener,noreferrer")}
                        data-testid={`clickup-row-${t.id}`}
                      >
                        <div class="flex items-start gap-2">
                          <span class="flex-1 min-w-0 text-[12.5px] text-fg break-words">
                            {t.title}
                          </span>
                          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                            <button
                              type="button"
                              class="text-fg-subtle hover:text-fg px-0.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                void copy(t.url, "Link");
                              }}
                              title="Copy link"
                              data-testid={`clickup-copy-link-${t.id}`}
                            >
                              🔗
                            </button>
                            <button
                              type="button"
                              class="text-fg-subtle hover:text-fg px-0.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                void copy(t.id, "ID");
                              }}
                              title="Copy ID"
                              data-testid={`clickup-copy-id-${t.id}`}
                            >
                              #
                            </button>
                          </div>
                        </div>
                        <div class="flex items-center flex-wrap gap-1">
                          <span class={`ag-chip !text-[10px] ${statusClass(t.status)}`}>
                            {t.status}
                          </span>
                          <Show when={t.priority}>
                            <span class="ag-chip !text-[10px]">{t.priority}</span>
                          </Show>
                          <For each={t.labels.slice(0, 2)}>
                            {(label) => <span class="ag-chip !text-[10px]">{label}</span>}
                          </For>
                          <Show when={t.assignee}>
                            <span class="text-[10.5px] text-fg-subtle">@{t.assignee}</span>
                          </Show>
                          <span class="flex-1" />
                          <button
                            type="button"
                            class="ag-btn ag-btn-primary ag-btn-xs shrink-0"
                            disabled={working() !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPickFor(pickFor() === t.id ? null : t.id);
                            }}
                            data-testid={`clickup-work-${t.id}`}
                          >
                            {working() === t.id ? "…" : "Work on this"}
                          </button>
                        </div>
                      </div>
                      <Show when={pickFor() === t.id}>
                        <div
                          class="px-3 pb-2 pt-1 bg-bg-2 border-t border-border"
                          data-testid={`clickup-project-picker-${t.id}`}
                        >
                          <div class="text-[10px] uppercase tracking-wide text-fg-subtle mb-1">
                            Create worktree in…
                          </div>
                          <Show
                            when={state.projects.length > 0}
                            fallback={
                              <div class="text-[11px] text-fg-subtle py-1">No projects yet.</div>
                            }
                          >
                            <div class="space-y-0.5">
                              <For each={state.projects}>
                                {(p) => (
                                  <button
                                    type="button"
                                    class="w-full text-left px-2 py-1 rounded hover:bg-bg-3 text-fg truncate text-[12px]"
                                    onClick={() => void work(t.id, p.id)}
                                    data-testid={`clickup-pick-${t.id}-${p.id}`}
                                  >
                                    {p.name}
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
