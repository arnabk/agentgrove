import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { api, type MemoryReport } from "../api/client";

/**
 * Top-right memory pill + popover. Shows the BE backend RSS + the
 * current browser tab's JS heap (Chromium only). Click to expand a
 * breakdown including each live PTY child.
 */
export default function MemoryIndicator() {
  const [report, setReport] = createSignal<MemoryReport | null>(null);
  const [tabHeap, setTabHeap] = createSignal<JsHeap | null>(null);
  const [open, setOpen] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | null = null;
  let rootEl: HTMLDivElement | undefined;

  async function refresh() {
    try {
      setReport(await api.getMemory());
    } catch {
      // ignore — BE may be momentarily down
    }
    setTabHeap(readPerformanceMemory());
  }

  onMount(() => {
    void refresh();
    timer = setInterval(() => void refresh(), 2000);
    document.addEventListener("mousedown", onDocDown);
  });
  onCleanup(() => {
    if (timer) clearInterval(timer);
    document.removeEventListener("mousedown", onDocDown);
  });

  function onDocDown(e: MouseEvent) {
    if (!open()) return;
    if (rootEl && !rootEl.contains(e.target as Node)) setOpen(false);
  }

  const beBytes = () => report()?.backend.rss_bytes ?? 0;
  const totalBytes = () => report()?.total_rss_bytes ?? 0;
  const tabBytes = () => tabHeap()?.usedJSHeapSize ?? 0;

  return (
    <div
      ref={(el) => (rootEl = el)}
      class="relative"
      data-testid="mem-indicator"
    >
      <button
        type="button"
        class="ag-chip flex items-center gap-1.5 font-mono cursor-pointer hover:bg-bg-3"
        onClick={() => setOpen(!open())}
        title="Click for breakdown"
        data-testid="mem-indicator-toggle"
      >
        <span class="text-fg-subtle">BE</span>
        <span class="text-fg">{fmtBytes(beBytes())}</span>
        <Show when={tabHeap()}>
          <span class="text-fg-subtle">·</span>
          <span class="text-fg-subtle">Tab</span>
          <span class="text-fg">{fmtBytes(tabBytes())}</span>
        </Show>
      </button>

      <Show when={open()}>
        <div
          class="absolute right-0 top-full mt-2 w-80 max-w-[90vw] z-50 rounded-lg border border-border bg-bg-1 shadow-2xl p-3 text-[12px]"
          role="dialog"
          aria-label="Memory breakdown"
          data-testid="mem-popover"
        >
          <div class="flex items-center justify-between mb-2">
            <span class="font-semibold text-[12.5px]">Memory</span>
            <span
              class="ag-chip font-mono"
              title="Sum of backend + child PTYs"
            >
              total {fmtBytes(totalBytes())}
            </span>
          </div>

          <Section title="Backend">
            <Row
              name={report()?.backend.name ?? "agentgrove"}
              pid={report()?.backend.pid}
              rss={beBytes()}
              virt={report()?.backend.virt_bytes}
            />
          </Section>

          <Section
            title={`Terminals (${report()?.children.length ?? 0})`}
            empty={(report()?.children.length ?? 0) === 0 ? "none" : undefined}
          >
            <For each={report()?.children ?? []}>
              {(c) => (
                <Row
                  name={c.name}
                  pid={c.pid}
                  rss={c.rss_bytes}
                  virt={c.virt_bytes}
                  kindLabel={c.kind.replace(/^terminal:/, "term ").slice(0, 12)}
                />
              )}
            </For>
          </Section>

          <Show when={tabHeap()}>
            <Section title="Browser tab (this page)">
              <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-fg-muted">
                <span>used</span>
                <span class="text-fg text-right">
                  {fmtBytes(tabHeap()!.usedJSHeapSize)}
                </span>
                <span>total</span>
                <span class="text-right">
                  {fmtBytes(tabHeap()!.totalJSHeapSize)}
                </span>
                <span>limit</span>
                <span class="text-right">
                  {fmtBytes(tabHeap()!.jsHeapSizeLimit)}
                </span>
              </div>
            </Section>
          </Show>
          <Show when={!tabHeap()}>
            <p class="mt-2 text-[11px] text-fg-subtle">
              Browser tab heap is only reported by Chromium/Edge.
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Section(props: {
  title: string;
  empty?: string | undefined;
  children?: import("solid-js").JSX.Element | undefined;
}) {
  return (
    <div class="mt-2 pt-2 border-t border-border first:border-t-0 first:mt-0 first:pt-0">
      <div class="text-[10.5px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">
        {props.title}
      </div>
      <Show when={!props.empty} fallback={<p class="text-[11.5px] text-fg-subtle">{props.empty}</p>}>
        {props.children}
      </Show>
    </div>
  );
}

function Row(props: {
  name: string;
  pid?: number | undefined;
  rss: number;
  virt?: number | undefined;
  kindLabel?: string | undefined;
}) {
  return (
    <div
      class="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0 font-mono items-baseline"
      title={`pid ${props.pid ?? "?"} · virt ${fmtBytes(props.virt ?? 0)}`}
    >
      <span class="truncate">
        <Show when={props.kindLabel}>
          <span class="text-fg-subtle mr-1">{props.kindLabel}</span>
        </Show>
        <span class="text-fg">{props.name}</span>
        <Show when={props.pid}>
          <span class="text-fg-subtle ml-1">#{props.pid}</span>
        </Show>
      </span>
      <span class="text-fg text-right">{fmtBytes(props.rss)}</span>
    </div>
  );
}

function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const fixed = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(fixed)} ${units[i]}`;
}

interface JsHeap {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Chromium-only: window.performance.memory. Returns null elsewhere. */
function readPerformanceMemory(): JsHeap | null {
  const perf = (
    typeof performance !== "undefined" ? (performance as unknown) : null
  ) as { memory?: JsHeap } | null;
  if (!perf || !perf.memory) return null;
  const m = perf.memory;
  if (
    typeof m.usedJSHeapSize !== "number" ||
    typeof m.totalJSHeapSize !== "number" ||
    typeof m.jsHeapSizeLimit !== "number"
  )
    return null;
  return {
    usedJSHeapSize: m.usedJSHeapSize,
    totalJSHeapSize: m.totalJSHeapSize,
    jsHeapSizeLimit: m.jsHeapSizeLimit,
  };
}
