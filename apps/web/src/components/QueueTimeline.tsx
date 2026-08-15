import { For, Show } from "solid-js";
import type { QueueItem } from "../api/client";
import { QueueCard } from "./queueCard";

/**
 * Inline queue rendered at the BOTTOM of the chat timeline, after the
 * last turn and just above the composer. Replaces the old right-sidebar
 * queue dock — queued messages now live in the conversation flow so the
 * user sees exactly what is lined up next.
 *
 * Items stay editable / removable until the agent is busy: while a turn
 * is in flight the whole queue is `locked` (per the product decision) so
 * nothing can be mutated mid-dispatch.
 *
 * State + actions are owned by ChatPane (which already holds the WS
 * connection + busy signal); this component is purely presentational.
 */
export default function QueueTimeline(props: {
  items: QueueItem[];
  busy: boolean;
  /** True while the agent is working — locks the whole queue. */
  locked: boolean;
  expanded: Set<string>;
  onToggleExpanded: (id: string) => void;
  onCancel: (item: QueueItem) => void;
  onUpdate: (item: QueueItem, body: string) => void;
  onRunNext: () => void;
  /** Called when any card enters/leaves edit mode (item id + state) so
   *  the parent can pause queue polling during an edit. */
  onItemEditing: (itemId: string, editing: boolean) => void;
}) {
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
              title="The running message can't be changed; pending ones below are still editable."
            >
              sending…
            </span>
          </Show>

          {/* Manual-only queue: the user decides what goes next. There
              is no auto-send — "Send next" dispatches the head item. */}
          <Show when={!props.locked}>
            <button
              type="button"
              class="ml-auto ag-btn ag-btn-primary ag-btn-sm shrink-0"
              disabled={props.busy}
              onClick={() => props.onRunNext()}
              title="Send the next queued message into the chat now"
              data-testid="queue-run-next"
            >
              ▸ Send next
            </button>
          </Show>
        </div>

        <div class="space-y-2 max-h-80 overflow-y-auto pr-2" data-testid="queue-items">
          <For each={props.items}>
            {(item, i) => (
              <div class="animate-[ag-queue-enter_180ms_ease-out]">
                <QueueCard
                  item={item}
                  index={i()}
                  isNext={i() === 0}
                  busy={props.busy}
                  // Only the item actually being dispatched (status
                  // "running") is immutable. Pending items behind it stay
                  // editable / removable even while the head is in flight —
                  // the user explicitly wants to fix up queued messages
                  // without waiting for the current turn to finish.
                  locked={item.status === "running"}
                  expanded={props.expanded.has(item.id)}
                  onToggle={() => props.onToggleExpanded(item.id)}
                  onCancel={() => props.onCancel(item)}
                  onUpdate={(body) => props.onUpdate(item, body)}
                  onSendNow={() => props.onRunNext()}
                  onEditingChange={(editing) => props.onItemEditing(item.id, editing)}
                />
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
