import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { api, type QueueItem, type QueueState } from "../api/client";

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

  async function updateItemBody(item: QueueItem, body: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.updateQueueItem(props.chatId, item.id, body);
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

  /** Run the next pending item now — pushes the top of the queue into
   *  the chat immediately, regardless of auto/manual mode. This is the
   *  "send this queued message into the chat" action the queue was
   *  missing. */
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

  return (
    <Show when={props.open}>
      {/* The queue lives inside the RightSidebar's bottom slot, which
          already owns the panel width + a resize handle. So we simply
          fill that slot (w-full / h-full) rather than rendering our own
          fixed-width dock — that's why the rows looked too narrow and
          didn't use the full width. */}
      <aside
        class="relative w-full h-full bg-bg-1 flex flex-col min-h-0"
        data-testid="queue-dock"
        aria-label="Queue"
      >
        <header class="px-4 py-2.5 border-b border-border bg-bg-1 space-y-1.5">
          <div class="flex items-center gap-2">
            <h3 class="text-[13.5px] font-semibold tracking-tight">Queue</h3>
            <span class="ag-chip text-[11px]" data-testid="queue-total">
              {total()}
            </span>

            {/* Auto-drain toggle. ON = pending items send back-to-back
                as the agent finishes; OFF = they wait until you send
                them. */}
            <label
              class="ml-auto inline-flex items-center gap-2 select-none cursor-pointer"
              title={
                mode() === "auto"
                  ? "Auto-send ON — queued messages send automatically as soon as the agent finishes."
                  : "Auto-send OFF — queued messages wait until you click Send."
              }
            >
              <span class="text-[11px] text-fg-subtle uppercase tracking-wider">Auto-send</span>
              <button
                type="button"
                role="switch"
                aria-checked={mode() === "auto"}
                disabled={busy()}
                onClick={() => void setMode(mode() === "auto" ? "manual" : "auto")}
                data-testid={mode() === "auto" ? "queue-mode-auto" : "queue-mode-manual"}
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
          </div>

          {/* Status line + actions. Makes it obvious what the queue is
              doing and gives a one-click way to push the next message
              into the chat. */}
          <div class="flex items-center gap-2">
            <p
              class="text-[11px] text-fg-subtle min-w-0 flex-1 truncate"
              data-testid="queue-status"
            >
              <Show when={total() > 0} fallback="Nothing queued.">
                <Show
                  when={mode() === "auto"}
                  fallback={`${total()} waiting — click Send to dispatch the next one.`}
                >
                  {`${total()} waiting — sending automatically as the agent frees up.`}
                </Show>
              </Show>
            </p>
            <Show when={total() > 0}>
              <button
                type="button"
                class="ag-btn ag-btn-primary ag-btn-sm shrink-0"
                disabled={busy()}
                onClick={() => void runNext()}
                title="Send the next queued message into the chat now"
                data-testid="queue-run-next"
              >
                ▸ Send next
              </button>
            </Show>
          </div>

          <Show when={err()}>
            <p class="text-[11px] text-danger" title={err() ?? ""}>
              {err()}
            </p>
          </Show>
        </header>

        <div class="flex-1 overflow-y-auto px-3 py-3 space-y-2 min-h-0" data-testid="queue-items">
          <Show
            when={total() > 0}
            fallback={
              <p class="text-center text-[12.5px] text-fg-subtle py-8" data-testid="queue-empty">
                Queue is empty. Type a message while the agent is working to line it up here.
              </p>
            }
          >
            <For each={items()}>
              {(item, i) => (
                <QueueCard
                  item={item}
                  index={i()}
                  isNext={i() === 0}
                  busy={busy()}
                  expanded={expanded().has(item.id)}
                  onToggle={() => toggleExpanded(item.id)}
                  onCancel={() => void cancel(item)}
                  onUpdate={(body) => void updateItemBody(item, body)}
                  onSendNow={() => void runNext()}
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
  index: number;
  isNext: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onUpdate: (body: string) => void;
  onSendNow: () => void;
}) {
  const split = createMemo(() => splitBodyAndAttachments(props.item.body));
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let inputRef: HTMLTextAreaElement | undefined;

  function startEdit() {
    setDraft(split().body);
    setEditing(true);
    queueMicrotask(() => {
      if (inputRef) {
        inputRef.focus();
        inputRef.style.height = "0px";
        inputRef.style.height = `${inputRef.scrollHeight}px`;
      }
    });
  }

  function commitEdit() {
    const newBody = draft();
    setEditing(false);
    if (newBody !== split().body) {
      const full = split().rawSuffix ? `${newBody}\n\n${split().rawSuffix}` : newBody;
      props.onUpdate(full);
    }
  }

  function cancelEdit() {
    setEditing(false);
  }

  return (
    <article
      class="rounded-lg border bg-bg-2 p-3 space-y-2"
      classList={{
        // Highlight the item that will go next so the order is obvious.
        "border-accent/60 ring-1 ring-accent/30": props.isNext,
        "border-border": !props.isNext,
      }}
      data-testid={`queue-card-${props.item.id}`}
    >
      <header class="flex items-center gap-2 text-[11.5px]">
        {/* Position badge — makes the queue order explicit. */}
        <span
          class="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-[10px] font-semibold"
          classList={{
            "bg-accent text-[var(--ag-accent-fg)]": props.isNext,
            "bg-bg-3 text-fg-subtle": !props.isNext,
          }}
          title={props.isNext ? "Next to send" : `Position ${props.index + 1} in queue`}
        >
          {props.isNext ? "next" : props.index + 1}
        </span>
        <span class="text-fg-subtle">{new Date(props.item.created_at).toLocaleTimeString()}</span>
        <div class="ml-auto flex items-center gap-1">
          {/* Per-item "Send now" only on the next item (run_next sends
              the head of the queue). One-click push into the chat. */}
          <Show when={props.isNext}>
            <button
              type="button"
              class="ag-btn ag-btn-ghost ag-btn-sm !py-0.5 !px-1.5 !text-[11px] text-accent"
              disabled={props.busy}
              onClick={() => props.onSendNow()}
              title="Send this message into the chat now"
              data-testid={`queue-send-now-${props.item.id}`}
            >
              ▸ Send now
            </button>
          </Show>
          <button
            type="button"
            class="text-fg-subtle hover:text-danger"
            onClick={() => props.onCancel()}
            title="Remove"
            aria-label="Remove"
            data-testid={`queue-cancel-${props.item.id}`}
          >
            ✕
          </button>
        </div>
      </header>

      <Show
        when={props.expanded || split().body.length <= 240 || editing()}
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
          <Show
            when={!editing()}
            fallback={
              <div class="space-y-2">
                <textarea
                  ref={(el) => (inputRef = el)}
                  class="ag-input !py-1.5 !px-2 font-sans text-[12.5px] leading-snug w-full resize-none overflow-hidden"
                  value={draft()}
                  onInput={(e) => {
                    setDraft(e.currentTarget.value);
                    e.currentTarget.style.height = "0px";
                    e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  data-testid={`queue-card-edit-input-${props.item.id}`}
                />
                <div class="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost ag-btn-sm"
                    onClick={cancelEdit}
                    data-testid={`queue-card-edit-cancel-${props.item.id}`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="ag-btn ag-btn-primary ag-btn-sm"
                    onClick={commitEdit}
                    data-testid={`queue-card-edit-save-${props.item.id}`}
                  >
                    Save
                  </button>
                </div>
              </div>
            }
          >
            <div class="group/body relative" onDblClick={startEdit} title="Double-click to edit">
              <pre
                class="text-[12.5px] text-fg leading-snug whitespace-pre-wrap font-sans"
                data-testid={`queue-card-body-${props.item.id}`}
              >
                {split().body || <em class="text-fg-subtle">(no text)</em>}
              </pre>
              <button
                type="button"
                class="absolute top-0 right-0 opacity-0 group-hover/body:opacity-100 p-1 text-fg-subtle hover:text-fg bg-bg-1 border border-border rounded shadow-sm"
                onClick={startEdit}
                aria-label="Edit item"
                data-testid={`queue-card-edit-${props.item.id}`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                </svg>
              </button>
            </div>
          </Show>
          <Show when={!editing() && split().body.length > 240}>
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
        <ul class="flex flex-wrap gap-1.5" data-testid={`queue-card-attachments-${props.item.id}`}>
          <For each={split().attachments}>
            {(a) => (
              <li class="ag-chip font-mono text-[11px] flex items-center gap-1" title={a.path}>
                <Show
                  when={a.mime?.startsWith("image/")}
                  fallback={<span class="text-fg-subtle">📎</span>}
                >
                  <span class="text-fg-subtle">🖼</span>
                </Show>
                <span class="truncate max-w-[200px]">{basename(a.path)}</span>
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
  rawSuffix?: string;
}

const ATTACHMENT_MARKER = "Attached files (absolute paths, read with your Read tool):";

function splitBodyAndAttachments(raw: string): SplitResult {
  const idx = raw.indexOf(ATTACHMENT_MARKER);
  if (idx < 0) {
    return { body: raw, attachments: [] };
  }
  const body = raw.slice(0, idx).trimEnd();
  const rawSuffix = raw.slice(idx);
  const trailer = raw.slice(idx + ATTACHMENT_MARKER.length);
  const attachments: ParsedAttachment[] = [];
  for (const line of trailer.split("\n")) {
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
  return { body, attachments, rawSuffix };
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

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
