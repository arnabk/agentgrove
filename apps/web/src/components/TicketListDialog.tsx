import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import { api, type TicketRow } from "../api/client";
import { pushToast } from "./Toast";

export default function TicketListDialog(props: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [working, setWorking] = createSignal<string | null>(null);
  const [tickets, { refetch }] = createResource<TicketRow[]>(() =>
    api.listTickets(props.projectId),
  );

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = tickets() ?? [];
    if (!q) return list;
    return list.filter((t) =>
      [t.title, t.id, `#${t.id}`, t.status, t.assignee ?? "", t.labels.join(" ")]
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

  function statusClass(status: string): string {
    const s = status.toLowerCase();
    if (s === "open" || s === "opened" || s === "to do" || s === "todo") return "ag-chip-success";
    if (s === "in_progress" || s === "in progress" || s === "doing") return "ag-chip-warn";
    if (s === "closed" || s === "done" || s === "complete") return "text-fg-subtle";
    return "";
  }

  function providerLabel(provider: string): string {
    switch (provider) {
      case "github":
        return "GitHub";
      case "gitlab":
        return "GitLab";
      case "clickup":
        return "ClickUp";
      default:
        return provider;
    }
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

  async function work(ticket: TicketRow) {
    if (working()) return;
    setWorking(ticket.id);
    try {
      await api.workOnTicket(props.projectId, ticket.id, ticket.provider);
      pushToast({
        title: "Worktree created",
        message: `#${ticket.id} ${ticket.title}`,
        level: "info",
      });
      props.onClose();
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
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tickets"
      data-testid="ticket-list"
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
          <span class="text-lg">🎫</span>
          <h2 class="text-[14px] font-semibold tracking-tight shrink-0">
            Tickets — {props.projectName}
          </h2>
          <input
            class="ag-input flex-1 min-w-0 !py-1.5"
            placeholder="Search by title, id, status, label, assignee…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            data-testid="ticket-search"
            autofocus
          />
          <span class="ag-chip font-mono text-fg-subtle" data-testid="ticket-count">
            {filtered().length}
            <Show when={query().trim()}>/{(tickets() ?? []).length}</Show>
          </span>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => void refetch()}
            disabled={tickets.loading}
            title="Refresh"
            data-testid="ticket-refresh"
          >
            ↻
          </button>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => props.onClose()}
            aria-label="Close tickets"
            data-testid="ticket-close"
          >
            ✕
          </button>
        </header>

        <div class="flex-1 overflow-y-auto">
          <Show
            when={!tickets.loading}
            fallback={
              <p class="text-center text-[12.5px] text-fg-subtle py-10">Loading tickets…</p>
            }
          >
            <Show
              when={filtered().length > 0}
              fallback={
                <p
                  class="text-center text-[12.5px] text-fg-subtle py-10"
                  data-testid="ticket-empty"
                >
                  <Show
                    when={(tickets() ?? []).length === 0}
                    fallback="No tickets match your search."
                  >
                    No tickets found. Connect a ticket source in Settings → Integrations.
                  </Show>
                </p>
              }
            >
              <ul class="divide-y divide-border">
                <For each={filtered()}>
                  {(t) => (
                    <li>
                      <div
                        class="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-2 transition-colors cursor-pointer"
                        onClick={() => window.open(t.url, "_blank", "noopener,noreferrer")}
                        data-testid={`ticket-row-${t.provider}-${t.id}`}
                      >
                        <span
                          class="ag-chip ag-chip-accent shrink-0"
                          title={providerLabel(t.provider)}
                        >
                          {providerLabel(t.provider)}
                        </span>
                        <span class="font-mono text-fg-subtle text-[12px] shrink-0">#{t.id}</span>
                        <span class="flex-1 min-w-0 truncate text-[13px]">{t.title}</span>
                        <For each={t.labels.slice(0, 3)}>
                          {(label) => (
                            <span class="ag-chip !text-[10px] shrink-0 hidden md:inline">
                              {label}
                            </span>
                          )}
                        </For>
                        <Show when={t.assignee}>
                          <span class="text-[11.5px] text-fg-subtle shrink-0 hidden sm:inline">
                            @{t.assignee}
                          </span>
                        </Show>
                        <span
                          class={`ag-chip !text-[10px] shrink-0 ${statusClass(t.status)}`}
                          title={`Status: ${t.status}`}
                        >
                          {t.status}
                        </span>
                        <button
                          type="button"
                          class="ag-btn ag-btn-ghost ag-btn-sm shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            void copy(t.url, "Link");
                          }}
                          title="Copy link"
                          data-testid={`ticket-copy-link-${t.id}`}
                        >
                          🔗
                        </button>
                        <button
                          type="button"
                          class="ag-btn ag-btn-ghost ag-btn-sm shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            void copy(t.id, "ID");
                          }}
                          title="Copy ID"
                          data-testid={`ticket-copy-id-${t.id}`}
                        >
                          #
                        </button>
                        <button
                          type="button"
                          class="ag-btn ag-btn-primary ag-btn-sm shrink-0"
                          disabled={working() !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            void work(t);
                          }}
                          data-testid={`ticket-work-${t.id}`}
                        >
                          {working() === t.id ? "…" : "Work on this"}
                        </button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
