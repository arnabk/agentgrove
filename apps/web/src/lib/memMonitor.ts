/**
 * Client memory / resource growth monitor.
 *
 * The "Aw, Snap" renderer crash (11 GB RSS over ~18 h) left no JS-side
 * trace, so we instrument the app to report its own growth. A timer
 * samples the signals we can actually see from JS and forwards a compact
 * snapshot to the backend client log (`<state_dir>/logs/client.log`), so
 * a long-running tab leaves a trend we can read after the fact.
 *
 * What we sample and why:
 *
 *   - **JS heap** (`performance.memory.usedJSHeapSize`) — the classic
 *     leak signal. Flat in our short tests, so a rising curve here
 *     points at a real object/closure leak.
 *   - **DOM node count** — detached-node leaks (retained by a stale
 *     closure / listener) don't show in heap but balloon renderer RSS.
 *     This is the likeliest culprit for an 11 GB RSS with a 15 MB heap.
 *   - **Open WebSocket count** — each chat/terminal pane opens a socket
 *     with a reconnect loop; a leak here multiplies network + handler
 *     closures. We wrap WebSocket construction to count live sockets.
 *   - **Per-subsystem attributed bytes** (the memory accountant) — the
 *     breakdown that tells us WHICH subsystem grew.
 *
 * Cadence: a cheap sample every SAMPLE_MS (kept in a small ring buffer
 * for spike detection), and a log line every REPORT_MS so the client log
 * holds a durable trend without flooding. A growth spike (heap or DOM
 * climbing steadily across the ring) triggers an immediate WARN line so
 * the moment of runaway is captured, not just the periodic heartbeat.
 */

import { logClient, sendMemSample } from "../api/client";
import { memorySnapshot } from "./memory";

const SAMPLE_MS = 15_000;
const REPORT_MS = 5 * 60_000;
/** Ring buffer of recent samples used to detect a sustained climb. */
const RING = 8;
/** When the monitor started — used for a tab-uptime x-axis in the log. */
const START_MS = Date.now();

interface Sample {
  t: number;
  heapMB: number;
  /** JS heap ceiling (MB) so a rising heap can be read against its cap. */
  heapLimitMB: number;
  dom: number;
  ws: number;
  /** Whole-tab bytes (measureUserAgentSpecificMemory), -1 if unavailable. */
  tabBytes: number;
  /** Estimated live event listeners (leak-prone). */
  listeners: number;
  /** Whether the tab was visible at sample time. */
  visible: boolean;
  /** Largest attributed subsystem at sample time (id + bytes). */
  top: string;
  topBytes: number;
}

const ring: Sample[] = [];
let started = false;

// ---- live WebSocket counting ------------------------------------------------
// Wrap the global constructor so every pane's socket (chat, terminal,
// worktree-script) is counted. We hook open/close to maintain a live count.
let liveSockets = 0;
function instrumentWebSocket() {
  const Original = window.WebSocket;
  class CountedWebSocket extends Original {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      liveSockets++;
      this.addEventListener("close", () => {
        liveSockets = Math.max(0, liveSockets - 1);
      });
    }
  }
  // Preserve statics + prototype expectations some libs rely on.
  Object.setPrototypeOf(CountedWebSocket, Original);
  window.WebSocket = CountedWebSocket as unknown as typeof WebSocket;
}

function heapMB(): number {
  const m = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return m?.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1048576) : -1;
}

function heapLimitMB(): number {
  const m = (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory;
  return m?.jsHeapSizeLimit ? Math.round(m.jsHeapSizeLimit / 1048576) : -1;
}

function domCount(): number {
  return document.getElementsByTagName("*").length;
}

// ---- listener counting -----------------------------------------------------
// Detached listeners are the classic invisible-heap leak (an 11 GB RSS
// with a 15 MB heap). We can't read the browser's internal listener
// table, but we CAN count our own add/removeEventListener calls by
// wrapping EventTarget once. The delta over time is the leak signal.
let liveListeners = 0;
function instrumentListeners() {
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  proto.addEventListener = function (this: EventTarget, ...args: Parameters<typeof add>) {
    liveListeners++;
    return add.apply(this, args);
  };
  proto.removeEventListener = function (this: EventTarget, ...args: Parameters<typeof remove>) {
    liveListeners = Math.max(0, liveListeners - 1);
    return remove.apply(this, args);
  };
}

function topSubsystem(): { id: string; bytes: number } {
  const snap = memorySnapshot();
  const first = snap.entries[0];
  return first ? { id: first.id, bytes: first.bytes } : { id: "none", bytes: 0 };
}

/** Most recent whole-tab measurement (bytes), refreshed opportunistically.
 *  `measureUserAgentSpecificMemory` is heavily throttled by the browser
 *  (can take seconds and resolves at GC boundaries), so we kick it off
 *  async and just read the last resolved value into each sample — never
 *  blocking the tick. */
let lastTabBytes = -1;
function refreshTabBytes() {
  const fn = (
    performance as unknown as {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    }
  ).measureUserAgentSpecificMemory;
  if (typeof fn !== "function") return;
  try {
    void fn()
      .then((r) => {
        if (r && typeof r.bytes === "number") lastTabBytes = r.bytes;
      })
      .catch(() => {});
  } catch {
    // ignore — API unavailable / not cross-origin isolated
  }
}

function takeSample(): Sample {
  const top = topSubsystem();
  return {
    t: Date.now(),
    heapMB: heapMB(),
    heapLimitMB: heapLimitMB(),
    dom: domCount(),
    ws: liveSockets,
    tabBytes: lastTabBytes,
    listeners: liveListeners,
    visible: document.visibilityState === "visible",
    top: top.id,
    topBytes: top.bytes,
  };
}

/** True when both heap and DOM climb monotonically across the ring — the
 *  signature of a runaway leak rather than a GC-coincident bump. */
function sustainedClimb(): boolean {
  if (ring.length < RING) return false;
  const heaps = ring.map((s) => s.heapMB).filter((h) => h >= 0);
  const doms = ring.map((s) => s.dom);
  const climbs = (xs: number[]) => xs.every((v, i) => i === 0 || v >= xs[i - 1]!);
  // Require the last value to be meaningfully above the first so we don't
  // fire on flat-but-jittery series.
  const heapUp = heaps.length === RING && climbs(heaps) && heaps[RING - 1]! - heaps[0]! >= 20;
  const domUp = climbs(doms) && doms[RING - 1]! - doms[0]! >= 500;
  return heapUp || domUp;
}

/** Push a structured sample to the dedicated mem.log trend (always),
 *  and — only for warnings — also drop a human line in client.log so a
 *  runaway is visible next to toasts. The mem.log series is the primary
 *  debugging artifact; client.log stays low-noise. */
function report(s: Sample, level: "info" | "warn", reason: string) {
  const snap = memorySnapshot();

  sendMemSample({
    reason,
    heap_mb: s.heapMB >= 0 ? s.heapMB : null,
    heap_limit_mb: s.heapLimitMB >= 0 ? s.heapLimitMB : null,
    tab_bytes: s.tabBytes >= 0 ? s.tabBytes : null,
    dom: s.dom,
    ws: s.ws,
    listeners: s.listeners,
    ag_total_bytes: snap.total,
    tab_uptime_s: Math.round((Date.now() - START_MS) / 1000),
    visible: s.visible,
    breakdown: snap.entries.slice(0, 8).map((e) => ({ id: e.id, bytes: e.bytes })),
  });

  if (level === "warn") {
    logClient({
      level,
      title: `mem-monitor: ${reason}`,
      message: `heap=${s.heapMB}MB dom=${s.dom} ws=${s.ws} listeners=${s.listeners} top=${s.top}(${Math.round(s.topBytes / 1024)}KB) total=${Math.round(snap.total / 1024)}KB`,
      context: {
        heapMB: s.heapMB,
        heapLimitMB: s.heapLimitMB,
        dom: s.dom,
        ws: s.ws,
        listeners: s.listeners,
        tabBytes: s.tabBytes,
        top: s.top,
        topBytes: s.topBytes,
        totalBytes: snap.total,
        breakdown: snap.entries.slice(0, 6).map((e) => ({ id: e.id, bytes: e.bytes })),
      },
    });
  }
}

/**
 * Start the monitor. Idempotent. Called once from the app root.
 */
export function startMemoryMonitor(): void {
  if (started) return;
  started = true;
  instrumentWebSocket();
  instrumentListeners();

  let lastReport = 0;
  const tick = () => {
    // Kick an async whole-tab measurement so the NEXT sample has a fresh
    // value; reading is throttled by the browser and never blocks here.
    refreshTabBytes();

    const s = takeSample();
    ring.push(s);
    if (ring.length > RING) ring.shift();

    const now = Date.now();
    if (sustainedClimb()) {
      report(s, "warn", "growth");
      // Reset the ring so we don't re-fire on the same climb every tick;
      // the next RING samples establish a fresh baseline.
      ring.length = 0;
      lastReport = now;
      return;
    }
    if (now - lastReport >= REPORT_MS) {
      lastReport = now;
      report(s, "info", "heartbeat");
    }
  };

  // Baseline sample shortly after load so the trend has a start point.
  setTimeout(() => {
    refreshTabBytes();
    setTimeout(() => report(takeSample(), "info", "load"), 500);
  }, 8_000);

  // Periodic cheap sample (spike detection + heartbeat throttling).
  setInterval(tick, SAMPLE_MS);

  // Final sample as the tab goes away — `keepalive` on the POST lets it
  // land, capturing the peak just before a crash/close. `pagehide` is
  // more reliable than `unload` on modern browsers.
  window.addEventListener("pagehide", () => {
    report(takeSample(), "info", "unload");
  });
}
