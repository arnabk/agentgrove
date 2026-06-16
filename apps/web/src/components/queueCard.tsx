import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { QueueItem } from "../api/client";

/** A single queue item rendered as a card.
 *
 *  Body parsing: we recognise the FE-generated "Attached files
 *  (absolute paths, …):" trailer that the chat input appends when
 *  uploads ride along with a prompt. The parsed list is rendered as
 *  attachment chips; the remaining text is the actual prompt. */
export function QueueCard(props: {
  item: QueueItem;
  index: number;
  isNext: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onUpdate: (body: string) => void;
  onSendNow: () => void;
  /** When true, hide the per-row edit / remove / send-now controls
   *  (the agent is busy and the queue is locked). */
  locked?: boolean;
  /** Notifies the parent when this card enters/leaves edit mode so it
   *  can pause queue polling — otherwise a poll refresh re-creates the
   *  row and silently drops the user's in-progress edit. */
  onEditingChange?: (editing: boolean) => void;
}) {
  const split = createMemo(() => splitBodyAndAttachments(props.item.body));
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let inputRef: HTMLTextAreaElement | undefined;

  // Surface edit state to the parent (for poll pausing). Also release on
  // unmount so a card removed mid-edit doesn't leave polling paused.
  createEffect(() => props.onEditingChange?.(editing()));
  onCleanup(() => props.onEditingChange?.(false));

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
          {/* While the agent is busy the queue is locked: hide the
              send-now + remove controls so items can't be mutated
              mid-turn. A small lock hint replaces them. */}
          <Show
            when={!props.locked}
            fallback={
              <span
                class="text-fg-subtle text-[10.5px] italic"
                title="Locked while the agent is working"
              >
                locked
              </span>
            }
          >
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
          </Show>
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
            <div
              class="group/body relative"
              onDblClick={() => !props.locked && startEdit()}
              title={props.locked ? "Locked while the agent is working" : "Double-click to edit"}
            >
              <pre
                class="text-[12.5px] text-fg leading-snug whitespace-pre-wrap font-sans"
                data-testid={`queue-card-body-${props.item.id}`}
              >
                {split().body || <em class="text-fg-subtle">(no text)</em>}
              </pre>
              <Show when={!props.locked}>
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
              </Show>
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

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
