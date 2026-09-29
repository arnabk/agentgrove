import { createSignal } from "solid-js";
import { logClient } from "@/core/api/client";

export interface ToastItem {
  id: string;
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
  timeoutMs?: number;
  /** Severity. Drives the persisted log level on the BE. Defaults to
   *  "info"; callers showing failures should pass "error". */
  level?: "error" | "warn" | "info";
}

/**
 * Headless toast queue. Lives in `core` rather than next to the
 * renderer so non-UI layers (stores, api error paths) can raise a
 * toast without importing a component — `core` is not allowed to
 * depend on `ui`. `ui/Toast.tsx` subscribes to `toasts()` and
 * re-exports the push/dismiss API for existing call sites.
 */
const [toasts, setToasts] = createSignal<ToastItem[]>([]);

export { toasts };

export const DEFAULT_TOAST_MS = 8000;

/** Titles that read like a failure are logged as errors so they're
 *  greppable in logs/client.log even after the toast disappears. */
const FAILURE_TITLE = /(fail|error|could not|unable|denied)/i;

export function toastLevel(item: Pick<ToastItem, "title" | "level">): "error" | "warn" | "info" {
  return item.level ?? (FAILURE_TITLE.test(item.title) ? "error" : "info");
}

export function pushToast(item: Omit<ToastItem, "id">) {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const full: ToastItem = { id, ...item };
  setToasts((prev) => [...prev, full]);
  setTimeout(() => dismissToast(id), item.timeoutMs ?? DEFAULT_TOAST_MS);
  logClient({
    level: toastLevel(item),
    title: item.title,
    message: item.message,
    context: { route: window.location.href },
  });
}

export function dismissToast(id: string) {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}
