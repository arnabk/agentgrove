/**
 * Subsystem-attributed FE memory accounting.
 *
 * The browser exposes two memory APIs — `performance.memory` (JS heap
 * only) and `performance.measureUserAgentSpecificMemory()` (whole-tab
 * process aggregate). Neither matches what Chrome's Task Manager
 * reports for the tab, because Chrome includes things like image
 * decode caches, GPU attribution, V8 isolate metadata, and per-frame
 * compositor overhead that JS can't see.
 *
 * Instead of trying to estimate the parts Chrome owns, we keep a
 * registry of the parts **AgentGrove owns** and lets each subsystem
 * report its current footprint. The MemoryIndicator surfaces the
 * total + breakdown as the canonical "AgentGrove" number, with the
 * browser-API values shown alongside for comparison.
 *
 * Each entry is identified by a stable string id (e.g. `chat.events`,
 * `terminal.scrollback`, `editor.documents`). Calling
 * `recordMemoryUsage(id, bytes)` overwrites the value for that id;
 * the registry takes care of computing the live total and notifying
 * subscribers.
 *
 * Costs are best-effort byte estimates. The conventions used:
 *
 * - JS strings cost `len * 2` bytes (UTF-16 representation).
 * - JSON values are estimated by `JSON.stringify(v).length * 2` for
 *   strings + a small fixed overhead per node. Cheap enough to call
 *   on a per-event basis.
 * - Binary blobs (xterm scrollback, editor docs) report their own
 *   byteLength.
 *
 * We do NOT count V8 hidden classes, closure environments, or
 * Tailwind classnames — those are unmeasurable from JS. The
 * accounting therefore *under*reports the real cost slightly, but it
 * is consistent across runs and shows the right relative shape.
 */

import { createStore, reconcile } from "solid-js/store";

/** A single subsystem entry. */
export interface MemoryEntry {
  /** Stable identifier, e.g. `chat.events`. */
  id: string;
  /** Human-readable label for the popover, e.g. `Chat events`. */
  label: string;
  /** Estimated bytes. */
  bytes: number;
}

/** Read-only view of the registry. */
export interface MemorySnapshot {
  total: number;
  entries: MemoryEntry[];
}

const labels: Record<string, string> = {};
const [store, setStore] = createStore<Record<string, number>>({});

/**
 * Declare a subsystem with its human label. Safe to call multiple
 * times; subsequent calls just update the label.
 */
export function declareMemorySource(id: string, label: string): void {
  labels[id] = label;
  if (!(id in store)) setStore(id, 0);
}

/**
 * Record (overwrite) the current byte estimate for a subsystem id.
 * Call this whenever the subsystem's size changes — adding events,
 * trimming scrollback, switching projects, etc.
 */
export function recordMemoryUsage(id: string, bytes: number): void {
  if (!(id in labels)) {
    // Auto-declare with the id as label if a caller forgot.
    labels[id] = id;
  }
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  setStore(id, Math.round(bytes));
}

/**
 * Drop a subsystem entirely (used when its owning context is
 * destroyed, e.g. a project deleted).
 */
export function clearMemorySource(id: string): void {
  setStore(reconcile({ ...store, [id]: undefined } as Record<string, number>));
  delete labels[id];
}

/**
 * Reactive snapshot of the whole registry. Subscribers re-run on any
 * change. The entries array is sorted by bytes descending so the
 * largest cost is always first in the popover.
 */
export function memorySnapshot(): MemorySnapshot {
  const ids = Object.keys(store);
  let total = 0;
  const entries: MemoryEntry[] = [];
  for (const id of ids) {
    const bytes = store[id] ?? 0;
    total += bytes;
    entries.push({ id, label: labels[id] ?? id, bytes });
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return { total, entries };
}

/**
 * Cheap estimate of the JS-string cost for `s`. UTF-16-backed JS
 * strings use 2 bytes per code unit; the +24 covers the typical V8
 * heap header for a sequential string.
 */
export function estimateStringBytes(s: string): number {
  if (!s) return 0;
  return s.length * 2 + 24;
}

/**
 * Cheap estimate of a JSON-serializable value's cost. Falls back to a
 * conservative constant when `JSON.stringify` throws (e.g. circular
 * references in dev). The overhead per object is intentionally tiny;
 * we expose the *order of magnitude*, not the precise heap footprint.
 */
export function estimateJsonBytes(v: unknown): number {
  if (v == null) return 8;
  if (typeof v === "string") return estimateStringBytes(v);
  if (typeof v === "number" || typeof v === "boolean") return 16;
  try {
    return JSON.stringify(v).length * 2 + 64;
  } catch {
    return 256;
  }
}
