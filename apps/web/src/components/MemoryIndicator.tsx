import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { api, type MemoryReport } from "../api/client";

/**
 * Top-right memory pill + popover. Shows the BE backend RSS + the
 * current browser tab's memory. Click to expand a breakdown including
 * each live PTY child.
 *
 * Tab memory uses two complementary sources:
 *
 *   1. `performance.measureUserAgentSpecificMemory()` — when the page
 *      is `crossOriginIsolated` (we set COOP/COEP on the dev + preview
 *      servers), this returns the **whole-tab** memory across JS heap,
 *      DOM, canvas, workers, embedded frames. Closest match to what
 *      Chrome's Task Manager reports.
 *   2. `performance.memory.usedJSHeapSize` — a coarse, bucketed
 *      JS-heap-only number. Fallback when #1 is unavailable. The pill
 *      label changes from `Tab` to `Tab JS` so the discrepancy with
 *      Chrome's Task Manager is explicit.
 */
export default function MemoryIndicator() {
  const [report, setReport] = createSignal<MemoryReport | null>(null);
  const [tabHeap, setTabHeap] = createSignal<JsHeap | null>(null);
  const [tabFull, setTabFull] = createSignal<TabFullMeasurement | null>(null);
  const [open, setOpen] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | null = null;
  let rootEl: HTMLDivElement | undefined;

  const canMeasureFullTab = isolatedAndSupported();

  async function refresh() {
    try {
      setReport(await api.getMemory());
    } catch {
      // ignore — BE may be momentarily down
    }
    setTabHeap(readPerformanceMemory());
    if (canMeasureFullTab) {
      try {
        const r = await measureFullTab();
        if (r) setTabFull(r);
      } catch {
        // measurement throttled (10s minimum interval) or denied;
        // keep last value
      }
    }
  }

  onMount(() => {
    void refresh();
    // measureUserAgentSpecificMemory is throttled at ~10s server-side;
    // poll at that cadence to match. BE poll stays at 2s via a
    // separate interval.
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
  /** Prefer the whole-tab measurement; fall back to JS heap. */
  const tabBytes = () => tabFull()?.bytes ?? tabHeap()?.usedJSHeapSize ?? 0;
  const tabLabel = () => (tabFull() ? "Tab" : "Tab JS");

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
        title={
          tabFull()
            ? "Backend RSS + whole-tab memory (DOM, JS heap, workers, GPU). Click for breakdown."
            : "Backend RSS + JS heap (Tab JS). Whole-tab memory needs crossOriginIsolated. Click for breakdown."
        }
        data-testid="mem-indicator-toggle"
      >
        <span class="text-fg-subtle">BE</span>
        <span class="text-fg">{fmtBytes(beBytes())}</span>
        <Show when={tabHeap() || tabFull()}>
          <span class="text-fg-subtle">·</span>
          <span class="text-fg-subtle">{tabLabel()}</span>
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

          <Show when={(report()?.children.length ?? 0) > 0}>
            <Section title={`Terminals (${report()?.children.length ?? 0})`}>
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
          </Show>

          <Show when={tabFull()}>
            <Section title="Browser tab (whole process)">
              <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-fg-muted">
                <span>used</span>
                <span class="text-fg text-right">{fmtBytes(tabFull()!.bytes)}</span>
                <For each={tabFull()!.breakdown ?? []}>
                  {(b) => (
                    <>
                      <span class="truncate" title={b.label}>
                        {b.label}
                      </span>
                      <span class="text-right">{fmtBytes(b.bytes)}</span>
                    </>
                  )}
                </For>
              </div>
              <p class="mt-1 text-[0.73em] text-fg-subtle">
                via performance.measureUserAgentSpecificMemory().
                Refreshes every ~10s.
              </p>
            </Section>
          </Show>
          <Show when={!tabFull() && tabHeap()}>
            <Section title="Browser tab (JS heap only)">
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
              <p class="mt-1 text-[0.73em] text-fg-subtle">
                JS heap only. Chrome Task Manager shows the full
                process RSS (DOM, image cache, GPU, workers).
                Whole-tab memory requires crossOriginIsolated.
              </p>
            </Section>
          </Show>
          <Show when={!tabHeap() && !tabFull()}>
            <p class="mt-2 text-[11px] text-fg-subtle">
              Browser tab memory is only reported by Chromium/Edge.
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Section(props: {
  title: string;
  children?: import("solid-js").JSX.Element | undefined;
}) {
  return (
    <div class="mt-2 pt-2 border-t border-border first:border-t-0 first:mt-0 first:pt-0">
      <div class="text-[10.5px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">
        {props.title}
      </div>
      {props.children}
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

/** Aggregated whole-tab memory plus grouped breakdown lines. */
interface TabFullMeasurement {
  bytes: number;
  breakdown: { label: string; bytes: number }[];
}

/** Type for the spec'd `performance.measureUserAgentSpecificMemory()`
 *  return value. We only need a subset. */
interface MeasureMemoryResult {
  bytes: number;
  breakdown: {
    bytes: number;
    attribution: { url?: string; scope?: string }[];
    types: string[];
  }[];
}

/** True when this page can call `measureUserAgentSpecificMemory()` —
 *  the page must be crossOriginIsolated and the function must exist. */
function isolatedAndSupported(): boolean {
  if (typeof self === "undefined") return false;
  const isolated =
    (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return false;
  return (
    typeof (performance as unknown as { measureUserAgentSpecificMemory?: unknown })
      .measureUserAgentSpecificMemory === "function"
  );
}

/** Call `performance.measureUserAgentSpecificMemory()` (whole-tab,
 *  cross-context aggregate) and group its breakdown by attribution
 *  type so the popover can show a compact summary. The API is
 *  throttled to once every ~10s; throttled calls reject. */
async function measureFullTab(): Promise<TabFullMeasurement | null> {
  const fn = (performance as unknown as {
    measureUserAgentSpecificMemory?: () => Promise<MeasureMemoryResult>;
  }).measureUserAgentSpecificMemory;
  if (typeof fn !== "function") return null;
  const r = await fn.call(performance);
  // Aggregate by primary type for a readable breakdown.
  const groups = new Map<string, number>();
  for (const entry of r.breakdown ?? []) {
    const t = entry.types?.[0] ?? "other";
    groups.set(t, (groups.get(t) ?? 0) + entry.bytes);
  }
  const breakdown = Array.from(groups.entries())
    .filter(([, b]) => b > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, bytes]) => ({ label, bytes }));
  return { bytes: r.bytes, breakdown };
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
