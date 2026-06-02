import { createEffect, onCleanup, onMount } from "solid-js";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api/client";
import { declareMemorySource, recordMemoryUsage } from "../lib/memory";

declareMemorySource("terminal.scrollback", "Terminal scrollback");

/** Recompute the global terminal-memory cost. xterm.js buffers each
 *  session's emitted bytes in its scrollback ring; `lastBytes` on our
 *  cached session is the running byte count we've consumed from the
 *  BE. Each byte costs ~2 bytes in the UTF-16-backed string buffer. */
function reportTerminalBytes(cache: Map<string, { lastBytes: number }>) {
  let total = 0;
  for (const sess of cache.values()) total += sess.lastBytes * 2;
  recordMemoryUsage("terminal.scrollback", total);
}
import { closeTerminalTab, currentScope, state } from "../stores/app";

/**
 * Per-scope terminal pane.
 *
 * Each PTY session lives on the BE and is referenced by id. The FE keeps
 * a persistent xterm instance per session in a module-level cache, so:
 *
 *   - Switching projects never tears down a terminal — the previous
 *     project's terminals stay alive on the BE and their xterm DOM nodes
 *     stay mounted but hidden.
 *   - Switching between this pane and Chat/Editor/Notes preserves
 *     scrollback and cursor position because the same xterm instance is
 *     reused.
 *
 * A tab strip at the top exposes per-scope sessions, with a `+` button
 * that spawns a new terminal. There is no client-side cap; the BE
 * surfaces resource errors directly. When a shell exits (Ctrl+D / exit)
 * the BE marks the session `exited`; the tab shows an "exited" chip but
 * remains visible until the user closes it.
 */

interface CachedSession {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  poll: { stop: boolean };
  lastBytes: number;
}

/** sessionId → cached xterm instance. Shared across project switches. */
const cache = new Map<string, CachedSession>();

export default function TerminalPane() {
  let stage!: HTMLDivElement;
  // sessionId -> exited

  const scope = () => currentScope();
  // Read from the unified tab model. Terminals used to live in their
  // own `scope.terminals` / `scope.activeTerminal` fields, but the app
  // migrated to a single `tabs[]` + `activeTab`. The old fields are no
  // longer maintained, so reading them left this pane empty (the PTY
  // was created on the BE but no xterm ever mounted). Derive the
  // terminal sessions and active id from the unified tabs instead.
  const tabs = () => (scope()?.tabs ?? []).filter((t) => t.kind === "terminal");
  const activeId = () => {
    const active = scope()?.activeTab ?? null;
    if (!active) return null;
    // Only treat the active tab as "the terminal" when it actually is
    // one; otherwise no terminal is foregrounded (e.g. a chat is active).
    return tabs().some((t) => t.id === active) ? active : null;
  };

  /** Tear down BE session + FE cached xterm + tab row. Shared by
   *  the user-initiated close (with confirm) and the auto-close
   *  triggered when the shell exits cleanly via Ctrl+D / `exit`. */
  async function destroyTab(id: string) {
    const c = cache.get(id);
    if (c) {
      c.poll.stop = true;
      try {
        c.term.dispose();
      } catch {
        // ignore
      }
      c.host.remove();
      cache.delete(id);
      reportTerminalBytes(cache);
    }
    try {
      await api.killTerminal(id);
    } catch {
      // even if BE fails to kill (already gone), drop the FE tab
    }
    closeTerminalTab(id);
  }

  /** Lazily create the cached xterm instance for a session id. */
  function ensureSession(id: string): CachedSession {
    const found = cache.get(id);
    if (found) return found;
    const host = document.createElement("div");
    host.style.position = "absolute";
    host.style.inset = "0";
    host.style.display = "none";
    host.dataset.testid = `term-${id}`;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      theme: {
        background: "var(--ag-bg-1)" as unknown as string,
        foreground: "#e8ecf2",
        cursor: "#7c5cff",
      },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((d) => void api.writeTerminal(id, d));
    const poll = { stop: false };
    const session: CachedSession = { term, fit, host, poll, lastBytes: 0 };
    cache.set(id, session);
    // Poll BE history + status loop. History pulls new bytes from the
    // PTY's ring buffer. Status reports whether the shell has exited so
    // the tab can render an "exited" chip without forcing a close.
    // Delta-poll loop. Per tick (~200ms) we ask the BE only for
    // bytes appended since our last known total; the response also
    // carries the exit flag, so there's no separate status call.
    // The old approach pulled the ENTIRE ring buffer (up to
    // 200 KB) every 200ms which made the terminal feel laggy on
    // long-running shells — fast-typing latency was visibly worse
    // because every keystroke's render was racing the next poll.
    void (async () => {
      while (!poll.stop) {
        try {
          const delta = await api.terminalHistoryDelta(id, session.lastBytes);
          if (delta.bytes.length > 0) {
            term.write(delta.bytes);
          }
          // Always adopt the BE total — covers the case where the
          // ring dropped bytes off the front (our `since` fell off
          // the buffer and the BE returned the whole remaining
          // ring; `total` may be lower than our previous lastBytes).
          if (delta.total !== session.lastBytes) {
            session.lastBytes = delta.total;
            reportTerminalBytes(cache);
          }
          if (delta.exited) {
            await destroyTab(id);
            break;
          }
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    return session;
  }

  onMount(() => {
    // Mount all known sessions for the active project into the stage,
    // then reveal the active one.
    syncStage();
  });

  // Re-fit + tell BE PTY when the window resizes. Without this the
  // BE keeps the original cols/rows and the shell wraps wrong on any
  // pane/window resize (arrow-up + edit-in-place visibly scrambles
  // the buffer). ResizeObserver on the stage would be ideal but
  // window.resize fires for the common cases (browser resize, FE
  // pane width change via the LeftRail handle).
  const onWindowResize = () => {
    const a = activeId();
    if (!a) return;
    const sess = cache.get(a);
    if (sess) fitAndResize(a, sess);
  };
  onMount(() => {
    window.addEventListener("resize", onWindowResize);
  });
  onCleanup(() => {
    window.removeEventListener("resize", onWindowResize);
  });

  /** Run xterm's FitAddon for `id` AND tell the BE PTY about the
   *  new cols/rows. Skipping the BE half is what causes the
   *  display-garble bug: xterm draws at the new width but the
   *  shell still thinks it has 80 cols, so its line-wrap math is
   *  off by however far the visible width drifted from 80. After
   *  this call both sides agree on the dimensions and arrow-up /
   *  edit-in-place stops scrambling the buffer. */
  function fitAndResize(id: string, sess: CachedSession) {
    try {
      sess.fit.fit();
    } catch {
      /* not sized yet */
      return;
    }
    const cols = sess.term.cols;
    const rows = sess.term.rows;
    void api.resizeTerminal(id, cols, rows).catch(() => {
      // Network errors are benign — the BE still has the old size
      // and the user can re-trigger resize by changing pane size.
    });
  }

  /** Reconcile the stage's children with the active project's terminals,
   *  showing only the active session's host. Called whenever the
   *  selected project or active terminal id changes. */
  function syncStage() {
    if (!stage) return;
    const want = new Set(tabs().map((t) => t.id));
    // Detach any host belonging to a project we're not currently showing.
    for (const child of Array.from(stage.children)) {
      const el = child as HTMLElement;
      const id = el.dataset.testid?.replace(/^term-/, "");
      if (!id || !want.has(id)) {
        // Leave the host in the cache (but remove from current stage) so
        // switching back to that project re-attaches it.
        stage.removeChild(el);
      }
    }
    for (const t of tabs()) {
      const sess = ensureSession(t.id);
      if (sess.host.parentElement !== stage) {
        stage.appendChild(sess.host);
      }
    }
    const a = activeId();
    for (const t of tabs()) {
      const sess = cache.get(t.id);
      if (!sess) continue;
      sess.host.style.display = t.id === a ? "block" : "none";
      if (t.id === a) {
        fitAndResize(t.id, sess);
        sess.term.focus();
      }
    }
  }

  // React to project switch + active-terminal change.
  createEffect(() => {
    void state.selectedProjectId;
    void activeId();
    void tabs().length;
    syncStage();
  });

  onCleanup(() => {
    // Don't dispose terminals on unmount — they survive across pane
    // switches. Cleanup happens on explicit closeTab() / project delete.
  });

  return (
    <section data-testid="terminal-pane" class="flex flex-col h-full">
      <div
        class="relative flex-1 bg-bg-1"
        ref={(el) => (stage = el)}
        data-testid="term-stage"
      ></div>
    </section>
  );
}
