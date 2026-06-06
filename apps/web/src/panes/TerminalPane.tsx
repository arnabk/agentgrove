import { createEffect, onCleanup, onMount } from "solid-js";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, openTerminalWs } from "../api/client";
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
  /** Live socket carrying PTY output (in) + keystrokes (out). */
  ws: WebSocket;
  /** Set when we deliberately tear the session down so the socket's
   *  close handler doesn't try to reconnect. */
  closing: boolean;
  /** Running total of bytes received — drives the memory accountant. */
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
      c.closing = true;
      try {
        c.ws.close();
      } catch {
        // ignore
      }
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

    // Open the bidirectional stream. Output arrives as binary frames and
    // is written straight to xterm (no polling); keystrokes are sent back
    // over the same socket (no per-keystroke HTTP). This is what makes
    // the terminal feel native — round-trip latency is just the loopback
    // socket, and output renders the instant the PTY emits it.
    const ws = openTerminalWs(id);
    const session: CachedSession = { term, fit, host, ws, closing: false, lastBytes: 0 };
    cache.set(id, session);

    // Keystrokes / pastes -> PTY. Send raw bytes so control sequences
    // (arrows, Ctrl-C, etc.) pass through untouched.
    term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(d);
      } else {
        // Socket not up yet (or reconnecting) — fall back to HTTP so a
        // keystroke is never silently dropped.
        void api.writeTerminal(id, d);
      }
    });

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        // Control frame. The only one we emit is {"exited":true}.
        try {
          const msg = JSON.parse(ev.data) as { exited?: boolean };
          if (msg.exited) void destroyTab(id);
        } catch {
          // Non-JSON text is unexpected; ignore.
        }
        return;
      }
      // Binary PTY output.
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      term.write(bytes);
      session.lastBytes += bytes.byteLength;
      reportTerminalBytes(cache);
    };

    ws.onclose = () => {
      // If we didn't close it ourselves, the shell/connection ended.
      if (!session.closing) void destroyTab(id);
    };

    return session;
  }

  onMount(() => {
    // Mount all known sessions for the active project into the stage,
    // then reveal the active one.
    syncStage();
  });

  // Re-fit + tell BE PTY when the stage resizes. ResizeObserver
  // catches ALL layout triggers: window resize, sidebar toggle, left
  // rail drag, zoom change — anything that changes the available
  // space for the terminal. The old window.resize listener missed
  // intra-page layout shifts (sidebar open/close) which left the
  // terminal at a stale size.
  onMount(() => {
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      const a = activeId();
      if (!a) return;
      const sess = cache.get(a);
      if (sess) fitAndResize(a, sess);
    });
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
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
    // After re-fitting, ensure the viewport scrolls to the latest
    // output. Without this, switching to a terminal tab that was
    // mounted at a stale size leaves the scrollbar mid-buffer — the
    // user sees old output and has to scroll down manually.
    sess.term.scrollToBottom();
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
        // Defer fit to the next animation frame so the browser has
        // reflowed the now-visible host (display:none → block). Without
        // this, FitAddon measures 0×0, computes the wrong cols/rows, and
        // the terminal doesn't scroll to the bottom or renders at a
        // stale size — the "doesn't scroll until refresh" bug.
        window.requestAnimationFrame(() => {
          fitAndResize(t.id, sess);
          sess.term.focus();
        });
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
