import { For, Show, createSignal, onCleanup } from "solid-js";
import { api, type ChatSchedule } from "@/core/api/client";

export const UNITS = { s: 1, m: 60, h: 3600, d: 86400 } as const;
export type Unit = keyof typeof UNITS;
/** Matches the server's minimum (crates/agentgrove-api/src/schedules.rs). */
export const MIN_INTERVAL_SECS = 10;

/** Largest unit that divides `secs` evenly, e.g. 7200 → "2h". */
export function formatInterval(secs: number): string {
  for (const u of ["d", "h", "m"] as const) {
    if (secs % UNITS[u] === 0) return `${secs / UNITS[u]}${u}`;
  }
  return `${secs}s`;
}

/** "in 4m" / "in 12s" / "now" for a unix-ms timestamp. */
export function formatUntil(ms: number, now: number): string {
  const secs = Math.round((ms - now) / 1000);
  if (secs <= 0) return "now";
  return `in ${formatInterval(secs <= 90 ? secs : Math.round(secs / 60) * 60)}`;
}

/**
 * Recurring messages for one chat, shown just above the composer.
 * The server owns the schedules and sends them on its own clock; this
 * view only lists and edits them, and re-reads when the server says
 * one fired or changed (`onRef` hands ChatPane a `refresh` handle for
 * that).
 */
export default function ChatSchedules(props: {
  chatId: string;
  /** Text currently in the composer, offered as the new schedule's message. */
  draft: () => string;
  creating: boolean;
  onCloseCreate: () => void;
  onRef: (refresh: () => void) => void;
}) {
  const [items, setItems] = createSignal<ChatSchedule[]>([]);
  const [err, setErr] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [body, setBody] = createSignal("");
  const [mode, setMode] = createSignal<"every" | "at">("every");
  const [every, setEvery] = createSignal(1);
  const [unit, setUnit] = createSignal<Unit>("h");
  const [at, setAt] = createSignal("");

  async function refresh() {
    const id = props.chatId;
    try {
      const list = await api.listSchedules(id);
      if (id === props.chatId) setItems(list);
    } catch {
      // Non-critical chrome; next refresh retries.
    }
  }
  props.onRef(() => void refresh());
  void refresh();
  // Ticks the "next in …" labels; also a backstop resync every 30s.
  const clock = setInterval(() => setNow(Date.now()), 1000);
  const resync = setInterval(() => void refresh(), 30_000);
  onCleanup(() => {
    clearInterval(clock);
    clearInterval(resync);
  });

  const secs = () => Math.round(every() * UNITS[unit()]);
  const message = () => (body() || props.draft()).trim();
  /** Unix ms of the chosen one-time time, or 0 if unset/invalid. */
  const atMs = () => {
    const t = new Date(at()).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const atOk = () => atMs() > Date.now();
  const oneTime = () => mode() === "at";

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!message() || (oneTime() ? !atOk() : secs() < MIN_INTERVAL_SECS)) return;
    if (
      await run(() =>
        api.createSchedule(
          props.chatId,
          message(),
          oneTime() ? null : secs(),
          oneTime() ? atMs() : undefined,
        ),
      )
    ) {
      setBody("");
      props.onCloseCreate();
    }
  }

  return (
    <Show when={props.creating || items().length > 0}>
      <div class="px-4 pt-2 flex flex-col gap-1.5" data-testid="chat-schedules">
        <For each={items()}>
          {(s) => (
            <div
              class="flex items-center gap-2 rounded-md border border-border bg-bg-1 px-2 py-1 text-[12px]"
              classList={{ "opacity-60": !s.enabled }}
              data-testid={`chat-schedule-${s.id}`}
            >
              <span class="ag-chip font-mono !text-[10.5px] shrink-0">
                ⏱ {s.interval_secs === null ? "once" : `every ${formatInterval(s.interval_secs)}`}
              </span>
              <span class="flex-1 min-w-0 truncate text-fg" title={s.body}>
                {s.body}
              </span>
              <span class="text-fg-subtle text-[11px] shrink-0" data-testid="chat-schedule-next">
                {s.enabled
                  ? `next ${formatUntil(s.next_run_at, now())}`
                  : s.last_run_at !== null
                    ? "sent"
                    : "paused"}
              </span>
              <button
                type="button"
                class="ag-btn ag-btn-ghost ag-btn-xs"
                onClick={() =>
                  void run(() => api.updateSchedule(props.chatId, s.id, { enabled: !s.enabled }))
                }
                title={s.enabled ? "Pause" : "Resume"}
                aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
                data-testid={`chat-schedule-toggle-${s.id}`}
              >
                {s.enabled ? "Pause" : "Resume"}
              </button>
              <button
                type="button"
                class="ag-btn ag-btn-ghost ag-btn-xs text-fg-subtle hover:text-danger"
                onClick={() => void run(() => api.deleteSchedule(props.chatId, s.id))}
                title="Delete schedule"
                aria-label="Delete schedule"
                data-testid={`chat-schedule-delete-${s.id}`}
              >
                ✕
              </button>
            </div>
          )}
        </For>

        <Show when={props.creating}>
          <form
            class="flex flex-wrap items-center gap-2 rounded-md border border-accent bg-bg-1 px-2 py-1.5 text-[12px]"
            onSubmit={create}
            data-testid="chat-schedule-form"
          >
            <input
              class="ag-input flex-1 min-w-[12rem]"
              placeholder="Message to send"
              aria-label="Scheduled message"
              value={body() || props.draft()}
              onInput={(e) => setBody(e.currentTarget.value)}
              data-testid="chat-schedule-body"
            />
            <label class="flex items-center gap-1 text-fg-subtle">
              <select
                class="ag-input w-auto"
                aria-label="Schedule mode"
                value={mode()}
                onChange={(e) => setMode(e.currentTarget.value as "every" | "at")}
                data-testid="chat-schedule-mode"
              >
                <option value="every">every</option>
                <option value="at">once at</option>
              </select>
            </label>
            <Show
              when={mode() === "every"}
              fallback={
                <input
                  type="datetime-local"
                  class="ag-input w-auto"
                  aria-label="Send at"
                  value={at()}
                  onInput={(e) => setAt(e.currentTarget.value)}
                  data-testid="chat-schedule-at"
                />
              }
            >
              <input
                type="number"
                min="1"
                step="1"
                class="ag-input w-16"
                aria-label="Interval"
                value={every()}
                onInput={(e) => setEvery(Number(e.currentTarget.value) || 0)}
                data-testid="chat-schedule-every"
              />
              <select
                class="ag-input w-auto"
                aria-label="Interval unit"
                value={unit()}
                onChange={(e) => setUnit(e.currentTarget.value as Unit)}
                data-testid="chat-schedule-unit"
              >
                <option value="s">seconds</option>
                <option value="m">minutes</option>
                <option value="h">hours</option>
                <option value="d">days</option>
              </select>
            </Show>
            <button
              type="submit"
              class="ag-btn ag-btn-primary ag-btn-xs"
              disabled={!message() || (oneTime() ? !atOk() : secs() < MIN_INTERVAL_SECS)}
              title={
                oneTime()
                  ? "Pick a future time"
                  : secs() < MIN_INTERVAL_SECS
                    ? `Minimum is ${MIN_INTERVAL_SECS} seconds`
                    : ""
              }
              data-testid="chat-schedule-save"
            >
              Schedule
            </button>
            <button
              type="button"
              class="ag-btn ag-btn-ghost ag-btn-xs"
              onClick={() => props.onCloseCreate()}
            >
              Cancel
            </button>
          </form>
        </Show>
        <Show when={err()}>
          <span class="text-danger text-[11px]" data-testid="chat-schedule-error">
            {err()}
          </span>
        </Show>
      </div>
    </Show>
  );
}
