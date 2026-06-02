import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { api, type QueueItem, type QueueState } from "../api/client";

/** Resize bounds + persistence key for the queue dock width. Same
 *  pattern as the LeftRail's resize handle, but bound to the right
 *  edge of the chat pane so dragging LEFT grows the queue (and
 *  shrinks the chat) and dragging RIGHT shrinks the queue. */
const QUEUE_MIN_PX = 280;
const QUEUE_MAX_PX = 720;
const QUEUE_DEFAULT_PX = 420;
const QUEUE_LS_KEY = "ag-queue-w";

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

  // Width persistence + drag state. Mirrors LeftRail's resize
  // handle: handle sits on the LEFT edge of the dock (the boundary
  // between chat timeline and queue) so dragging LEFT widens the
  // queue at the expense of the chat.
  const persisted = Number(localStorage.getItem(QUEUE_LS_KEY));
  const initial =
    Number.isFinite(persisted) && persisted >= QUEUE_MIN_PX && persisted <= QUEUE_MAX_PX
      ? persisted
      : QUEUE_DEFAULT_PX;
  const [width, setWidth] = createSignal(initial);
  const [dragging, setDragging] = createSignal(false);

  function clamp(px: number) {
    return Math.min(QUEUE_MAX_PX, Math.max(QUEUE_MIN_PX, Math.round(px)));
  }

  function onPointerDown(ev: PointerEvent) {
    ev.preventDefault();
    setDragging(true);
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  function onPointerMove(ev: PointerEvent) {
    if (!dragging()) return;
    // Dock is right-anchored: width = (viewport right edge) -
    // (pointer x). Pointer moving LEFT grows the dock.
    const next = clamp(window.innerWidth - ev.clientX);
    setWidth(next);
  }
  function onPointerUp(ev: PointerEvent) {
    if (!dragging()) return;
    setDragging(false);
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch {
      // pointer might already be released
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(QUEUE_LS_KEY, String(width()));
  }
  function onKeyDown(ev: KeyboardEvent) {
    let next = width();
    // ArrowLeft grows the dock (matches the drag-LEFT-to-widen
    // semantics); ArrowRight shrinks it.
    if (ev.key === "ArrowLeft") next += ev.shiftKey ? 32 : 8;
    else if (ev.key === "ArrowRight") next -= ev.shiftKey ? 32 : 8;
    else if (ev.key === "Home") next = QUEUE_MAX_PX;
    else if (ev.key === "End") next = QUEUE_MIN_PX;
    else if (ev.key === "Enter" || ev.key === " ") next = QUEUE_DEFAULT_PX;
    else return;
    ev.preventDefault();
    setWidth(clamp(next));
    localStorage.setItem(QUEUE_LS_KEY, String(width()));
  }

  // Belt-and-braces: if pointer is released outside the handle
  // (e.g. over a child <iframe>) we still want to commit the width.
  const onWindowUp = () => {
    if (!dragging()) return;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(QUEUE_LS_KEY, String(width()));
  };
  onMount(() => {
    window.addEventListener("pointerup", onWindowUp);
  });
  onCleanup(() => {
    window.removeEventListener("pointerup", onWindowUp);
  });

  return (
    <Show when={props.open}>
      <aside
        class="relative shrink-0 h-full bg-bg-1 border-l border-border flex flex-col"
        style={{ width: `${width()}px` }}
        data-testid="queue-dock"
        aria-label="Queue"
      >
        {/* Resize handle on the LEFT edge of the dock. Pointer drag
            or arrow keys adjust width; persisted to localStorage. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize queue panel"
          aria-valuemin={QUEUE_MIN_PX}
          aria-valuemax={QUEUE_MAX_PX}
          aria-valuenow={width()}
          tabIndex={0}
          class="absolute top-0 left-0 h-full w-1.5 -ml-[3px] cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10 touch-none"
          classList={{ "!bg-accent/50": dragging() }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          data-testid="queue-dock-resize"
        />
        <header class="px-4 py-3 border-b border-border bg-bg-1">
          <div class="flex items-center gap-2">
            <h3 class="text-[13.5px] font-semibold tracking-tight">Queue</h3>
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
              <span class="text-[11px] text-fg-subtle uppercase tracking-wider">Auto</span>
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
            <p class="mt-1 text-[11px] text-danger" title={err() ?? ""}>
              {err()}
            </p>
          </Show>
        </header>

        <div class="flex-1 overflow-y-auto px-3 py-3 space-y-2" data-testid="queue-items">
          <Show
            when={total() > 0}
            fallback={
              <p class="text-center text-[12.5px] text-fg-subtle py-8" data-testid="queue-empty">
                Queue is empty. Type a message while the agent is working to enqueue it.
              </p>
            }
          >
            <For each={items()}>
              {(item) => (
                <QueueCard
                  item={item}
                  expanded={expanded().has(item.id)}
                  onToggle={() => toggleExpanded(item.id)}
                  onCancel={() => void cancel(item)}
                  onUpdate={(body) => void updateItemBody(item, body)}
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
  onUpdate: (body: string) => void;
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
        <span class="text-fg-subtle">{new Date(props.item.created_at).toLocaleTimeString()}</span>
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
