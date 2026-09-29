import { describe, it, expect } from "vitest";
import {
  MOBILE_MAX_WIDTH,
  MOBILE_MEDIA_QUERY,
  SHELL_OVERRIDE_KEY,
  isShellKind,
  readShellOverride,
  resolveShell,
  type ShellStore,
} from "@/core/lib/shellSelect";

function fakeStore(
  initial: Record<string, string> = {},
): ShellStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("shellSelect", () => {
  it("uses the md breakpoint so CSS utilities and the shell agree", () => {
    expect(MOBILE_MAX_WIDTH).toBe(767);
    expect(MOBILE_MEDIA_QUERY).toBe("(max-width: 767px)");
  });

  it("recognises only the two shell kinds", () => {
    expect(isShellKind("mobile")).toBe(true);
    expect(isShellKind("desktop")).toBe(true);
    expect(isShellKind("tablet")).toBe(false);
    expect(isShellKind(undefined)).toBe(false);
  });

  describe("resolveShell", () => {
    it("follows the viewport when there is no override", () => {
      expect(resolveShell(null, true)).toBe("mobile");
      expect(resolveShell(null, false)).toBe("desktop");
    });

    it("lets an override beat the viewport in both directions", () => {
      expect(resolveShell("desktop", true)).toBe("desktop");
      expect(resolveShell("mobile", false)).toBe("mobile");
    });
  });

  describe("readShellOverride", () => {
    it("returns null when nothing asks for an override", () => {
      expect(readShellOverride("", fakeStore())).toBeNull();
      expect(readShellOverride("?pane=chat", fakeStore())).toBeNull();
    });

    it("reads ?ui= and persists it so a reload keeps the shell", () => {
      const store = fakeStore();
      expect(readShellOverride("?ui=desktop", store)).toBe("desktop");
      expect(store.data.get(SHELL_OVERRIDE_KEY)).toBe("desktop");
    });

    it("falls back to the persisted value when the URL is silent", () => {
      const store = fakeStore({ [SHELL_OVERRIDE_KEY]: "mobile" });
      expect(readShellOverride("?chat=abc", store)).toBe("mobile");
    });

    it("lets ?ui= override a previously persisted choice", () => {
      const store = fakeStore({ [SHELL_OVERRIDE_KEY]: "mobile" });
      expect(readShellOverride("?ui=desktop", store)).toBe("desktop");
      expect(store.data.get(SHELL_OVERRIDE_KEY)).toBe("desktop");
    });

    it("clears the override on ?ui=auto and returns to the media query", () => {
      const store = fakeStore({ [SHELL_OVERRIDE_KEY]: "desktop" });
      expect(readShellOverride("?ui=auto", store)).toBeNull();
      expect(store.data.has(SHELL_OVERRIDE_KEY)).toBe(false);
    });

    it("ignores a junk ?ui= value rather than picking a shell at random", () => {
      const store = fakeStore();
      expect(readShellOverride("?ui=watch", store)).toBeNull();
      expect(store.data.has(SHELL_OVERRIDE_KEY)).toBe(false);
    });

    it("ignores a junk persisted value", () => {
      expect(readShellOverride("", fakeStore({ [SHELL_OVERRIDE_KEY]: "tablet" }))).toBeNull();
    });

    it("works with no storage at all (private-mode Safari)", () => {
      expect(readShellOverride("?ui=mobile", null)).toBe("mobile");
      expect(readShellOverride("", null)).toBeNull();
    });
  });
});
