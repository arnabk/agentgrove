import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  api,
  type QueueItem,
  type QueueState,
} from "../api/client";

/**
 * Per-chat queue panel, docked inline as the right column of the
 * chat pane. The chat owns this surface (queue is per-chat) so we
 * render it as a sibling of the timeline + composer rather than as
 * a fixed/overlayed drawer.
 *
 *   - Full-height of the chat pane; scrolls internally.
 *   - Renders each item as a card with status, body, attachment
 *     thumbnails parsed from the body, and per-row controls.
 *   - Hosts the mode toggle and "Run next" button at the top.
 *
 * The parent passes `open=true` when the user toggles the queue
 * badge in the chat header. We only paint when `open` is true so
 * the chat reclaims horizontal width when the queue is collapsed.
 *
 * Polling: 1 s while open. Auto-drain on the BE means most queues
 * shrink quickly; the FE just re-reads.
 */

interface Props {
  chatId: string;
  open: boolean;
  onClose: () => void;
}

export default function QueueDock(props: Props) {
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
  const total = () => items().length;
  const mode = () => qstate()?.mode ?? "auto";

  return (
    <Show when={props.open}>
      <aside
        class="w-[min(420px,40vw)] shrink-0 h-full bg-bg-1 border-l border-border flex flex-col"
        data-testid="queue-dock"
        aria-label="Queue"
      >
          <header class="px-4 py-3 border-b border-border bg-bg-1">
            <div class="flex items-center gap-2">
              <h3 class="text-[13.5px] font-semibold tracking-tight">
                Queue
              </h3>
              <span class="ag-chip text-[11px]" data-testid="queue-total">
                {total()}
              </span>

              {/*
                Auto-drain toggle — promoted into the header row so
                the queue dock keeps a single-row chrome. ON = items
                send back-to-back as the agent finishes; OFF =
                items wait until manually re-ordered or run. Both
                old test ids are aliased to this switch so existing
                tests keep working regardless of state.
              */}
              <label
                class="ml-auto inline-flex items-center gap-2 select-none cursor-pointer"
                title={
                  mode() === "auto"
                    ? "Auto-drain ON — pending messages send as soon as the agent finishes."
                    : "Auto-drain OFF — pending messages wait; reorder or send them yourself."
                }
              >
                <span class="text-[11px] text-fg-subtle uppercase tracking-wider">
                  Auto
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={mode() === "auto"}
                  disabled={busy()}
                  onClick={() =>
                    void setMode(mode() === "auto" ? "manual" : "auto")
                  }
                  data-testid={
                    mode() === "auto" ? "queue-mode-auto" : "queue-mode-manual"
                  }
                  class="relative inline-flex h-4 w-7 items-center rounded-full transition-colors disabled:opacity-50"
                  classList={{
                    "bg-accent": mode() === "auto",
                    "bg-bg-3 border border-border": mode() !== "auto",
                  }}
                >
                  <span
                    class="inline-block h-3 w-3 rounded-full bg-white shadow transition-transform"
                    classList={{
                      "translate-x-3.5": mode() === "auto",
                      "translate-x-0.5": mode() !== "auto",
                    }}
                  />
                </button>
              </label>

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
            <Show when={err()}>
              <p
                class="mt-1 text-[11px] text-danger"
                title={err() ?? ""}
              >
                {err()}
              </p>
            </Show>
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
      {/*
        Item header — timestamp + remove button only. Status labels
        were redundant here: an item only lives in the queue while
        it's waiting to run; once dispatched the BE moves it into
        the chat timeline and removes the row. Three lifecycle
        states are now possible from the user's perspective:

          - in the queue (this card is rendered)
          - in the chat timeline (it left the queue)
          - deleted (user clicked Remove → also gone from the queue)

        The remove button is unconditionally rendered; cancelling a
        queue item is a tracked-but-rare operation, never a footgun
        on items the user "shouldn't" cancel.
      */}
      <header class="flex items-center gap-2 text-[11.5px]">
        <span class="text-fg-subtle">
          {new Date(props.item.created_at).toLocaleTimeString()}
        </span>
        <button
          type="button"
          class="ml-auto text-fg-subtle hover:text-danger"
          onClick={() => props.onCancel()}
          title="Remove"
          aria-label="Remove"
          data-testid={`queue-cancel-${props.item.id}`}
        >
          ✕
        </button>
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
