import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  api,
  type QueueItem,
  type QueueState,
} from "../api/client";

/**
 * Right-side slide-in drawer rendering the chat's prompt queue.
 *
 * Replaces the earlier inline panel that sat above the chat input —
 * that surface didn't scale once queues started carrying tens or
 * hundreds of items with attachments. The drawer:
 *
 *   - is full-height and scrolls internally (any number of items)
 *   - renders each item as a card with status, body, attachment
 *     thumbnails parsed from the body, and per-row controls
 *   - hosts the mode toggle and "Run next" button at the top
 *
 * It's a sibling of ChangesPanel and follows the same backdrop +
 * close pattern. The parent controls visibility; this component only
 * paints when `open` is true.
 *
 * Polling: 1 s while open. Auto-drain on the BE means most queues
 * shrink quickly; the FE just re-reads.
 */

interface Props {
  chatId: string;
  open: boolean;
  onClose: () => void;
}

export default function QueueDrawer(props: Props) {
  const [qstate, setQstate] = createSignal<QueueState | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  async function refresh() {
    try {
      setQstate(await api.getQueue(props.chatId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Poll only while open + a chat is selected.
  createEffect(() => {
    if (!props.open) return;
    void props.chatId;
    void refresh();
    const id = setInterval(() => void refresh(), 1000);
    onCleanup(() => clearInterval(id));
  });

  async function setMode(mode: "auto" | "manual") {
    setBusy(true);
    setErr(null);
    try {
      await api.setQueueMode(props.chatId, mode);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runNext() {
    setBusy(true);
    setErr(null);
    try {
      await api.runNextQueue(props.chatId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(item: QueueItem) {
    setBusy(true);
    setErr(null);
    try {
      await api.cancelQueueItem(props.chatId, item.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const items = () => qstate()?.items ?? [];
  const pending = createMemo(() => items().filter((i) => i.status === "pending"));
  const total = () => items().length;
  const mode = () => qstate()?.mode ?? "auto";

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-40 flex justify-end"
        data-testid="queue-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Queue"
      >
        <div
          class="absolute inset-0 bg-black/40"
          onClick={() => props.onClose()}
        />
        <aside class="relative w-[min(520px,90vw)] h-full bg-bg-1 border-l border-border shadow-2xl flex flex-col">
          <header class="px-4 py-3 border-b border-border bg-bg-1">
            <div class="flex items-center gap-2">
              <h3 class="text-[13.5px] font-semibold tracking-tight">
                Queue
              </h3>
              <span class="ag-chip text-[11px]" data-testid="queue-total">
                {total()}
              </span>
              <Show when={pending().length > 0 && mode() === "auto"}>
                <span class="ag-chip ag-chip-accent text-[11px]">
                  auto-draining
                </span>
              </Show>
              <div class="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  class="ag-btn ag-btn-ghost ag-btn-sm"
                  onClick={() => void refresh()}
                  disabled={busy()}
                  title="Refresh"
                  data-testid="queue-refresh"
                >
                  ↻
                </button>
                <button
                  type="button"
                  class="ag-btn ag-btn-ghost ag-btn-sm"
                  onClick={() => props.onClose()}
                  aria-label="Close"
                  data-testid="queue-close"
                >
                  ✕
                </button>
              </div>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <div class="flex rounded-md border border-border overflow-hidden text-[11.5px]">
                <button
                  type="button"
                  class="px-2 py-1"
                  classList={{
                    "bg-bg-3 text-fg": mode() === "auto",
                    "text-fg-subtle hover:bg-bg-2": mode() !== "auto",
                  }}
                  disabled={busy()}
                  onClick={() => void setMode("auto")}
                  data-testid="queue-mode-auto"
                >
                  auto
                </button>
                <button
                  type="button"
                  class="px-2 py-1 border-l border-border"
                  classList={{
                    "bg-bg-3 text-fg": mode() === "manual",
                    "text-fg-subtle hover:bg-bg-2": mode() !== "manual",
                  }}
                  disabled={busy()}
                  onClick={() => void setMode("manual")}
                  data-testid="queue-mode-manual"
                >
                  manual
                </button>
              </div>
              <button
                type="button"
                class="ag-btn ag-btn-ghost ag-btn-sm"
                onClick={() => void runNext()}
                disabled={busy() || pending().length === 0}
                title="Pop and run the next pending item"
                data-testid="queue-run-next"
              >
                ▶ Run next
              </button>
              <Show when={err()}>
                <span
                  class="ml-auto text-[11px] text-danger"
                  title={err() ?? ""}
                >
                  {err()}
                </span>
              </Show>
            </div>
          </header>

          <div class="flex-1 overflow-y-auto px-3 py-3 space-y-2" data-testid="queue-items">
            <Show
              when={total() > 0}
              fallback={
                <p
                  class="text-center text-[12.5px] text-fg-subtle py-8"
                  data-testid="queue-empty"
                >
                  Queue is empty. Type a message while the agent is
                  working to enqueue it.
                </p>
              }
            >
              <For each={items()}>
                {(it) => (
                  <QueueCard
                    item={it}
                    expanded={expanded().has(it.id)}
                    onToggle={() => toggleExpanded(it.id)}
                    onCancel={() => void cancel(it)}
                  />
                )}
              </For>
            </Show>
          </div>
        </aside>
      </div>
    </Show>
  );
}

/** A single queue item rendered as a card.
 *
 *  Body parsing: we recognise the FE-generated "Attached files
 *  (absolute paths, …):" trailer that the chat input appends when
 *  uploads ride along with a prompt. The parsed list is rendered as
 *  attachment chips; the remaining text is the actual prompt. */
function QueueCard(props: {
  item: QueueItem;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const split = createMemo(() => splitBodyAndAttachments(props.item.body));

  return (
    <article
      class="rounded-lg border border-border bg-bg-2 p-3 space-y-2"
      data-testid={`queue-card-${props.item.id}`}
    >
      <header class="flex items-center gap-2 text-[11.5px]">
        <StatusDot status={props.item.status} />
        <span
          class="font-mono uppercase tracking-wide"
          classList={{
            "text-fg-subtle": props.item.status === "pending",
            "text-accent": props.item.status === "running",
            "text-success": props.item.status === "done",
            "text-danger": props.item.status === "cancelled",
          }}
        >
          {props.item.status}
        </span>
        <span class="ml-auto text-fg-subtle">
          {new Date(props.item.created_at).toLocaleTimeString()}
        </span>
        <Show when={props.item.status === "pending"}>
          <button
            type="button"
            class="text-fg-subtle hover:text-danger"
            onClick={() => props.onCancel()}
            title="Cancel"
            aria-label="Cancel"
            data-testid={`queue-cancel-${props.item.id}`}
          >
            ✕
          </button>
        </Show>
      </header>

      <Show
        when={props.expanded || split().body.length <= 240}
        fallback={
          <button
            type="button"
            class="block w-full text-left text-[12.5px] text-fg-muted truncate cursor-pointer hover:text-fg"
            onClick={() => props.onToggle()}
            title="Click to expand"
            data-testid={`queue-card-collapsed-${props.item.id}`}
          >
            {split().body.split("\n")[0] || "(empty)"}
          </button>
        }
      >
        <div class="space-y-2">
          <pre
            class="text-[12.5px] text-fg leading-snug whitespace-pre-wrap font-sans"
            data-testid={`queue-card-body-${props.item.id}`}
          >
            {split().body || <em class="text-fg-subtle">(no text)</em>}
          </pre>
          <Show when={split().body.length > 240}>
            <button
              type="button"
              class="text-[11px] text-fg-subtle hover:text-fg"
              onClick={() => props.onToggle()}
            >
              Collapse
            </button>
          </Show>
        </div>
      </Show>

      <Show when={split().attachments.length > 0}>
        <ul
          class="flex flex-wrap gap-1.5"
          data-testid={`queue-card-attachments-${props.item.id}`}
        >
          <For each={split().attachments}>
            {(a) => (
              <li
                class="ag-chip font-mono text-[11px] flex items-center gap-1"
                title={a.path}
              >
                <Show
                  when={a.mime?.startsWith("image/")}
                  fallback={<span class="text-fg-subtle">📎</span>}
                >
                  <span class="text-fg-subtle">🖼</span>
                </Show>
                <span class="truncate max-w-[200px]">
                  {basename(a.path)}
                </span>
                <Show when={a.mime}>
                  <span class="text-fg-subtle">·</span>
                  <span class="text-fg-subtle">{a.mime}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </article>
  );
}

interface ParsedAttachment {
  path: string;
  mime?: string;
}

interface SplitResult {
  body: string;
  attachments: ParsedAttachment[];
}

/** Split a queue-item body into the visible prompt text + the
 *  attachment list the chat input may have appended. The format we
 *  emit looks like:
 *
 *      <user text>
 *
 *      Attached files (absolute paths, read with your Read tool):
 *      - /abs/path/foo.png (image/png)
 *      - /abs/path/bar.txt (text/plain)
 *
 *  Parsing is forgiving: if no trailer is present, the whole body
 *  is returned verbatim. */
function splitBodyAndAttachments(raw: string): SplitResult {
  const marker = /\n\nAttached files \([^)]*\):\n/;
  const m = raw.match(marker);
  if (!m || m.index === undefined) {
    return { body: raw, attachments: [] };
  }
  const body = raw.slice(0, m.index);
  const tail = raw.slice(m.index + m[0].length);
  const attachments: ParsedAttachment[] = [];
  for (const line of tail.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2);
    // "PATH (MIME)" or just "PATH"
    const mimeMatch = rest.match(/^(.*) \(([^)]+)\)$/);
    if (mimeMatch && mimeMatch[2]) {
      attachments.push({ path: mimeMatch[1]!, mime: mimeMatch[2] });
    } else if (mimeMatch) {
      attachments.push({ path: mimeMatch[1]! });
    } else {
      attachments.push({ path: rest });
    }
  }
  return { body, attachments };
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Coloured dot reflecting QueueItem.status. */
function StatusDot(props: { status: QueueItem["status"] }) {
  const color = () => {
    switch (props.status) {
      case "pending":
        return "bg-fg-subtle";
      case "running":
        return "bg-accent animate-pulse";
      case "done":
        return "bg-success";
      case "cancelled":
        return "bg-danger/60";
    }
  };
  return (
    <span
      class={`inline-block w-1.5 h-1.5 rounded-full ${color()}`}
      title={props.status}
    />
  );
}
