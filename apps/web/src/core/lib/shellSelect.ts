import { createSignal, onCleanup } from "solid-js";

/**
 * Which form-factor shell to mount. Resolved before either shell
 * loads, so a phone never downloads the desktop bundle (and its
 * CodeMirror / xterm dependencies) and vice versa.
 *
 * The pure helpers here are deliberately free of globals so they can be
 * unit-tested without a DOM; `createShellSelector` is the only piece
 * that touches `window`.
 */
export type ShellKind = "desktop" | "mobile";

/** Phones and small tablets in portrait. Matches Tailwind's `md`
 *  breakpoint so utility classes and the shell agree on "mobile". */
export const MOBILE_MAX_WIDTH = 767;
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/** Sticky override, so "Desktop version" survives a reload. */
export const SHELL_OVERRIDE_KEY = "ag-ui-shell";

export function isShellKind(v: unknown): v is ShellKind {
  return v === "desktop" || v === "mobile";
}

/** A minimal slice of localStorage, so tests can pass a fake. */
export interface ShellStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Resolve a sticky override from the URL, falling back to whatever was
 * persisted earlier. `?ui=` wins and is written through, so a shared
 * link pins the shell for that browser until it is cleared.
 *
 * `?ui=auto` clears the override and returns to the media query.
 */
export function readShellOverride(search: string, store: ShellStore | null): ShellKind | null {
  const fromUrl = new URLSearchParams(search).get("ui");
  if (fromUrl === "auto") {
    store?.removeItem(SHELL_OVERRIDE_KEY);
    return null;
  }
  if (isShellKind(fromUrl)) {
    store?.setItem(SHELL_OVERRIDE_KEY, fromUrl);
    return fromUrl;
  }
  const persisted = store?.getItem(SHELL_OVERRIDE_KEY);
  return isShellKind(persisted) ? persisted : null;
}

/** An override always wins; otherwise the viewport decides. */
export function resolveShell(override: ShellKind | null, matchesMobile: boolean): ShellKind {
  if (override) return override;
  return matchesMobile ? "mobile" : "desktop";
}

/**
 * Reactive shell accessor. Re-evaluates when the media query flips, so
 * rotating a tablet or dragging a window across the breakpoint swaps
 * shells. That is safe because shell state is reconstructed from the
 * store and the backend, never held only in shell-local component state.
 */
export function createShellSelector(): () => ShellKind {
  const store: ShellStore | null = safeLocalStorage();
  const override = readShellOverride(window.location.search, store);
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  const [shell, setShell] = createSignal<ShellKind>(resolveShell(override, mql.matches));

  // An explicit override pins the shell; no point listening.
  if (!override) {
    const onChange = (e: MediaQueryListEvent) => setShell(resolveShell(null, e.matches));
    mql.addEventListener("change", onChange);
    onCleanup(() => mql.removeEventListener("change", onChange));
  }
  return shell;
}

/** Persist an explicit choice and reload into that shell. Used by the
 *  "Desktop version" / "Mobile version" escape hatches. */
export function switchShell(kind: ShellKind) {
  safeLocalStorage()?.setItem(SHELL_OVERRIDE_KEY, kind);
  const url = new URL(window.location.href);
  url.searchParams.delete("ui");
  window.location.replace(url.toString());
}

/** Private-mode Safari throws on localStorage access. */
function safeLocalStorage(): ShellStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
