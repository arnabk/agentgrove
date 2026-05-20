import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  api,
  type QueueItem,
  type QueueState,
} from "../api/client";

/**
 * Per-chat prompt-queue panel. Sits inside ChatPane above the input.
 *
 * The BE already owns the queue (`/api/chats/:id/queue` family);
 * this is the FE surface the user has been missing. Features:
 *
 *   - Show pending / running / done / cancelled items in order.
 *   - Toggle `auto` ↔ `manual` mode.
 *   - In manual mode, "Run next" pops the head pending item and
 *     dispatches it as a prompt. In auto mode the BE drains
 *     automatically after each turn (still to-wire on the BE; for
 *     now the FE polls and surfaces state truthfully).
 *   - Add prompt at the bottom; cancel pending items.
 *
 * Polling cadence: 2 s when the panel is collapsed, 1 s when
 * expanded. Cheap GET; the queue is tiny.
 */

interface Props {
  chatId: string;
  /** Open/close persisted by the parent so tab switches don't fight
   *  with the user's preference. */
  open: boolean;
  onToggle: (open: boolean) => void;
}

export default function QueuePanel(props: Props) {
  const [qstate, setQstate] = createSignal<QueueState | null>(null);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  async function refresh() {
    try {
      const next = await api.getQueue(props.chatId);
      setQstate(next);
    } catch (e) {
      // Don't surface poll failures as toasts; the queue is best-effort.
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Poll while the panel is mounted. The parent only mounts us when
  // the strip is visible, so the timer is naturally scoped.
  createEffect(() => {
    void props.chatId;
    setQstate(null);
    void refresh();
    const interval = props.open ? 1000 : 2500;
    const id = setInterval(() => void refresh(), interval);
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

  async function enqueue() {
    const body = draft().trim();
    if (!body) return;
    setBusy(true);
    setErr(null);
    try {
      await api.enqueue(props.chatId, body);
      setDraft("");
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

  const pending = () =>
    qstate()?.items.filter((i) => i.status === "pending") ?? [];
  const running = () =>
    qstate()?.items.filter((i) => i.status === "running") ?? [];
  const total = () => qstate()?.items.length ?? 0;
  const mode = () => qstate()?.mode ?? "auto";

  return (
    <div
      class="border-t border-border bg-bg-1"
      data-testid="chat-queue-panel"
    >
      <button
        type="button"
        class="w-full flex items-center gap-2 px-4 py-2 text-[12.5px] text-fg-muted hover:bg-bg-2"
        onClick={() => props.onToggle(!props.open)}
        aria-expanded={props.open}
        data-testid="chat-queue-toggle"
      >
        <span class="text-fg-subtle">{props.open ? "▾" : "▸"}</span>
        <span class="font-semibold text-fg">Queue</span>
        <span class="ag-chip text-[10.5px]">{total()}</span>
        <Show when={running().length > 0}>
          <span class="ag-chip ag-chip-accent text-[10.5px]">
            running
          </span>
        </Show>
        <span class="ml-auto text-[11px] text-fg-subtle">
          mode: {mode()}
        </span>
      </button>

      <Show when={props.open}>
        <div class="px-4 pb-3 space-y-2" data-testid="chat-queue-body">
          <div class="flex items-center gap-2">
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
                data-testid="chat-queue-mode-auto"
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
                data-testid="chat-queue-mode-manual"
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
              data-testid="chat-queue-run-next"
            >
              ▶ Run next
            </button>
            <Show when={err()}>
              <span
                class="ml-auto text-[11px] text-danger"
                data-testid="chat-queue-error"
                title={err() ?? ""}
              >
                {err()}
              </span>
            </Show>
          </div>

          <Show
            when={total() > 0}
            fallback={
              <p
                class="text-[12px] text-fg-subtle italic"
                data-testid="chat-queue-empty"
              >
                Queue is empty. Add a prompt below to enqueue it.
              </p>
            }
          >
            <ul class="space-y-1" data-testid="chat-queue-items">
              <For each={qstate()?.items ?? []}>
                {(it) => (
                  <li
                    class="flex items-center gap-2 text-[12px] font-mono"
                    data-testid={`chat-queue-item-${it.id}`}
                  >
                    <StatusDot status={it.status} />
                    <span class="truncate flex-1" title={it.body}>
                      {it.body}
                    </span>
                    <Show when={it.status === "pending"}>
                      <button
                        type="button"
                        class="text-fg-subtle hover:text-danger"
                        title="Cancel"
                        aria-label="Cancel"
                        onClick={() => void cancel(it)}
                        data-testid={`chat-queue-cancel-${it.id}`}
                      >
                        ✕
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void enqueue();
            }}
            class="flex gap-2"
          >
            <input
              class="ag-input flex-1"
              placeholder="Enqueue a prompt to run later…"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              disabled={busy()}
              data-testid="chat-queue-input"
            />
            <button
              type="submit"
              class="ag-btn ag-btn-primary ag-btn-sm"
              disabled={busy() || !draft().trim()}
              data-testid="chat-queue-add"
            >
              Add
            </button>
          </form>
        </div>
      </Show>
    </div>
  );
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
