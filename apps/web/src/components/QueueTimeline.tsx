import { For, Show } from "solid-js";
import type { QueueItem } from "../api/client";
import { QueueCard } from "./queueCard";

/**
 * Inline queue rendered at the BOTTOM of the chat timeline, after the
 * last turn and just above the composer. Queued messages live in the
 * conversation flow so the user sees exactly what is lined up next.
 *
 * Ordering + dispatch:
 *   - Items can be dragged to reorder (out-of-order sending) while the
 *     queue is unlocked. `onReorder` gets the new id order.
 *   - Any pending item exposes a per-card "Send now" that dispatches
 *     that specific item immediately (not just the head).
 *   - The auto/manual toggle controls whether pending items drain
 *     automatically as each turn finishes. Auto is sequential (the
 *     CLIs run one turn at a time), it just removes the manual click.
 *
 * State + actions are owned by ChatPane (which holds the WS connection
 * + busy signal); this component is purely presentational.
 */
export default function QueueTimeline(props: {
  items: QueueItem[];
  busy: boolean;
  /** True while the agent is working — the running item is immutable,
   *  but pending items stay editable / reorderable / dispatchable. */
  locked: boolean;
  /** Current drain mode. */
  mode: "auto" | "manual";
  expanded: Set<string>;
  onToggleExpanded: (id: string) => void;
  onCancel: (item: QueueItem) => void;
  onUpdate: (item: QueueItem, body: string) => void;
  onRunNext: () => void;
  /** Dispatch a specific item now, out of order. */
  onSendItem: (item: QueueItem) => void;
  /** Reorder pending items; receives the new id order (first = next). */
  onReorder: (orderedIds: string[]) => void;
  /** Flip the auto/manual drain mode. */
  onSetMode: (mode: "auto" | "manual") => void;
  /** Called when any card enters/leaves edit mode (item id + state) so
   *  the parent can pause queue polling during an edit. */
  onItemEditing: (itemId: string, editing: boolean) => void;
}) {
  let dragId: string | null = null;

  function pendingIds(): string[] {
    return props.items.filter((i) => i.status !== "running").map((i) => i.id);
  }

  function onDrop(targetId: string) {
    const from = dragId;
    dragId = null;
    if (!from || from === targetId) return;
    const ids = pendingIds();
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, from);
    props.onReorder(next);
  }

  return (
    <Show when={props.items.length > 0}>
      <section
        class="border-t border-border bg-bg-1 px-4 py-3 space-y-2 animate-[ag-queue-enter_200ms_ease-out]"
        data-testid="queue-timeline"
        aria-label="Queued messages"
      >
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
            Queued
          </span>
          <span class="ag-chip text-[11px]" data-testid="queue-timeline-total">
            {props.items.length}
          </span>
          <Show when={props.locked}>
            <span
              class="text-[10.5px] text-fg-subtle italic"
              title="The running message can't be changed; pending ones below are still editable and reorderable."
            >
              sending…
            </span>
          </Show>

          <div class="ml-auto flex items-center gap-2">
            {/* Auto/manual drain toggle. Auto sends the next queued
                message automatically when the current turn ends. */}
            <label
              class="flex items-center gap-1.5 text-[11px] text-fg-muted cursor-pointer select-none"
              title="Auto: send the next queued message automatically when the current turn finishes (sequential, not parallel). Manual: wait for you to send each one."
            >
              <input
                type="checkbox"
                class="accent-[var(--ag-accent)]"
                checked={props.mode === "auto"}
                onChange={(e) => props.onSetMode(e.currentTarget.checked ? "auto" : "manual")}
                data-testid="queue-mode-auto"
              />
              Auto-send
            </label>
            <Show when={!props.locked}>
              <button
                type="button"
                class="ag-btn ag-btn-primary ag-btn-sm shrink-0"
                disabled={props.busy}
                onClick={() => props.onRunNext()}
                title="Send the next queued message into the chat now"
                data-testid="queue-run-next"
              >
                ▸ Send next
              </button>
            </Show>
          </div>
        </div>

        <div class="space-y-2 max-h-80 overflow-y-auto pr-2" data-testid="queue-items">
          <For each={props.items}>
            {(item, i) => {
              const draggable = () => !props.locked && item.status !== "running";
              return (
                <div
                  class="animate-[ag-queue-enter_180ms_ease-out]"
                  draggable={draggable()}
                  onDragStart={(e) => {
                    if (!draggable()) return;
                    dragId = item.id;
                    e.dataTransfer?.setData("text/plain", item.id);
                  }}
                  onDragOver={(e) => {
                    if (draggable() && dragId && dragId !== item.id) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    onDrop(item.id);
                  }}
                  data-testid={`queue-drag-${item.id}`}
                >
                  <QueueCard
                    item={item}
                    index={i()}
                    isNext={i() === 0}
                    busy={props.busy}
                    // Any pending item can be sent out of order.
                    canSend={item.status !== "running"}
                    draggable={draggable()}
                    // Only the item actually being dispatched (status
                    // "running") is immutable. Pending items behind it
                    // stay editable / removable / dispatchable.
                    locked={item.status === "running"}
                    expanded={props.expanded.has(item.id)}
                    onToggle={() => props.onToggleExpanded(item.id)}
                    onCancel={() => props.onCancel(item)}
                    onUpdate={(body) => props.onUpdate(item, body)}
                    onSendNow={() => props.onSendItem(item)}
                    onEditingChange={(editing) => props.onItemEditing(item.id, editing)}
                  />
                </div>
              );
            }}
          </For>
        </div>
      </section>
    </Show>
  );
}
