import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/core/api/client", () => ({ logClient: vi.fn() }));

import { logClient } from "@/core/api/client";
import { DEFAULT_TOAST_MS, dismissToast, pushToast, toastLevel, toasts } from "@/core/lib/toastBus";

describe("toastBus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const t of toasts()) dismissToast(t.id);
    vi.mocked(logClient).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("queues a pushed toast and assigns it an id", () => {
    pushToast({ title: "Saved", message: "All good" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.id).toMatch(/^toast-/);
    expect(toasts()[0]!.title).toBe("Saved");
  });

  it("auto-dismisses after the default timeout", () => {
    pushToast({ title: "Saved", message: "" });
    vi.advanceTimersByTime(DEFAULT_TOAST_MS - 1);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
  });

  it("honours a per-toast timeout", () => {
    pushToast({ title: "Saved", message: "", timeoutMs: 100 });
    vi.advanceTimersByTime(100);
    expect(toasts()).toHaveLength(0);
  });

  it("dismisses only the requested toast", () => {
    pushToast({ title: "A", message: "" });
    pushToast({ title: "B", message: "" });
    dismissToast(toasts()[0]!.id);
    expect(toasts().map((t) => t.title)).toEqual(["B"]);
  });

  it("infers an error level from failure-sounding titles", () => {
    expect(toastLevel({ title: "Export failed" })).toBe("error");
    expect(toastLevel({ title: "Could not reach backend" })).toBe("error");
    expect(toastLevel({ title: "Permission denied" })).toBe("error");
    expect(toastLevel({ title: "Response ready" })).toBe("info");
  });

  it("prefers an explicit level over the inferred one", () => {
    expect(toastLevel({ title: "Export failed", level: "warn" })).toBe("warn");
  });

  it("mirrors every toast to the backend client log", () => {
    pushToast({ title: "Export failed", message: "disk full" });
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Export failed", message: "disk full" }),
    );
  });
});
