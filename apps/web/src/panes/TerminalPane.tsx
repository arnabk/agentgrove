import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, openTerminalWs } from "../api/client";
import { declareMemorySource, recordMemoryUsage } from "../lib/memory";

declareMemorySource("terminal.scrollback", "Terminal scrollback");

/** Lines of scrollback xterm keeps per terminal. This bounds the
 *  terminal's real retention (a ring buffer of rows×cols×lines), so
 *  explicit is better than relying on the library default. */
const SCROLLBACK_LINES = 2000;

function reportTerminalBytes(cache: Map<string, CachedSession>) {
  let total = 0;
  for (const sess of cache.values()) {
    // Bound the estimate by the ring-buffer size instead of cumulative
    // bytes written: xterm discards lines beyond SCROLLBACK_LINES, so
    // the retained footprint is stable and ~4 bytes/cell (char + attr).
    const cols = sess.term.cols || 80;
    const rows = sess.term.rows || 24;
    const cells = (SCROLLBACK_LINES + rows) * cols;
    total += cells * 4;
  }
  recordMemoryUsage("terminal.scrollback", total);
}
import { closeTerminalTab, replaceTerminalId } from "../stores/app";

interface CachedSession {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  ws: WebSocket;
  closing: boolean;
  /** True once we've seen a clean shell exit (`exit` / Ctrl+D) or the
   *  backend told us the PTY is gone. Distinguishes an intentional end
   *  from a transient WS drop so `onclose` doesn't nuke a live tab. */
  ended: boolean;
  /** Set for one attempt after an unexpected WS close so a single
   *  transient drop reconnects (BE replays scrollback) instead of
   *  immediately declaring the terminal dead. */
  reconnected: boolean;
}

const cache = new Map<string, CachedSession>();

interface Props {
  terminalId: string;
  /** Working directory of the tab, used to respawn the shell in place
   *  when the original PTY is gone (e.g. after a backend restart). */
  cwd?: string | undefined;
}

export default function TerminalPane(props: Props) {
  let stage!: HTMLDivElement;

  // When the session can't be (re)attached — the PTY is gone after a
  // backend restart — we DON'T delete the tab. Instead we surface a
  // "session ended" overlay with a Restart action so a page refresh
  // never silently loses a terminal tab.
  const [dead, setDead] = createSignal(false);
  const [restarting, setRestarting] = createSignal(false);

  const id = () => props.terminalId;

  /** Fully tear down the tab: kill the PTY + remove the tab from the
   *  layout. ONLY called on an explicit user close, never on a lost
   *  connection (that would wipe restored tabs whose PTY is gone). */
  async function destroyTab() {
    const c = cache.get(id());
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
      cache.delete(id());
      reportTerminalBytes(cache);
    }
    try {
      await api.killTerminal(id());
    } catch {
      // even if BE fails to kill (already gone), drop the FE tab
    }
    closeTerminalTab(id());
  }

  /** The PTY is gone / unreachable. Keep the tab, tear down the local
   *  xterm + socket, and show the restart overlay. Does NOT remove the
   *  tab from the layout, so the terminal survives a refresh even when
   *  its backend session no longer exists. */
  function markDead() {
    const c = cache.get(id());
    if (c) {
      c.ended = true;
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
      cache.delete(id());
      reportTerminalBytes(cache);
    }
    setDead(true);
  }

  /** Spawn a fresh PTY in the tab's cwd and rebind the tab to the new
   *  session id, preserving its slot + label. */
  async function restart() {
    if (restarting()) return;
    setRestarting(true);
    try {
      const t = await api.createTerminal({
        cols: 80,
        rows: 24,
        ...(props.cwd ? { cwd: props.cwd } : {}),
      });
      // Rebind the tab id BEFORE re-rendering so the pane reconnects to
      // the new PTY. The id() accessor tracks props.terminalId, which
      // updates once the store swaps the tab id.
      replaceTerminalId(id(), t.id);
      setDead(false);
    } catch {
      // Leave the overlay up; the user can retry.
    } finally {
      setRestarting(false);
    }
  }

  function ensureSession(): CachedSession {
    const found = cache.get(id());
    if (found) return found;
    const host = document.createElement("div");
    host.style.position = "absolute";
    host.style.inset = "0";
    host.style.display = "none";
    host.dataset.testid = `term-${id()}`;
    // Resolve the theme background to a concrete color. Passing the raw
    // "var(--ag-bg-1)" string worked for the DOM-renderer stylesheet but
    // xterm's internal canvas layers (e.g. the scrollable element) parse
    // colors in JS, fail on var(), and fall back to #000 — which is what
    // the black strip on the terminal's right edge was.
    const termBg =
      getComputedStyle(document.documentElement).getPropertyValue("--ag-bg-1").trim() || "#14171c";
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      theme: {
        background: termBg,
        foreground: "#e8ecf2",
        cursor: "#7c5cff",
      },
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const ws = openTerminalWs(id());
    const session: CachedSession = {
      term,
      fit,
      host,
      ws,
      closing: false,
      ended: false,
      reconnected: false,
    };
    cache.set(id(), session);

    const currentId = id();
    term.onData((d) => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(d);
      } else {
        void api.writeTerminal(currentId, d);
      }
    });

    wireSocket(session);
    return session;
  }

  /** (Re)bind the message/close handlers on a session's current socket.
   *  Extracted so an unexpected drop can swap in a fresh socket and
   *  reuse the same logic. */
  function wireSocket(session: CachedSession) {
    const { term, ws } = session;
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as { exited?: boolean; error?: string };
          // Clean shell exit (`exit` / Ctrl+D): the user ended this
          // shell on purpose — remove the tab.
          if (msg.exited) {
            session.ended = true;
            void destroyTab();
            return;
          }
          // The PTY is gone (e.g. backend was restarted, so its
          // in-memory session map was cleared). Do NOT delete the tab —
          // keep it and offer a restart so a refresh never loses it.
          if (msg.error) {
            markDead();
            return;
          }
        } catch {
          // ignore malformed control frames
        }
        return;
      }
      // Any real output proves the socket is healthy — reset the
      // one-shot reconnect budget so a LATER drop can retry too.
      session.reconnected = false;
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      term.write(bytes);
    };

    ws.onclose = () => {
      // Ignore closes we initiated (destroyTab / markDead).
      if (session.closing || session.ended) return;
      // First unexpected drop: try ONE reconnect. The BE replays the
      // scrollback on re-subscribe, so a transient blip recovers
      // seamlessly. Only if that also fails do we declare the terminal
      // dead (and keep the tab + show Restart).
      if (!session.reconnected) {
        session.reconnected = true;
        try {
          session.ws = openTerminalWs(id());
          session.ws.binaryType = "arraybuffer";
          wireSocket(session);
          return;
        } catch {
          // fall through to markDead
        }
      }
      markDead();
    };
  }

  function fitAndResize(sess: CachedSession) {
    try {
      sess.fit.fit();
    } catch {
      return;
    }
    sess.term.scrollToBottom();
    reportTerminalBytes(cache);
    const cols = sess.term.cols;
    const rows = sess.term.rows;
    void api.resizeTerminal(id(), cols, rows).catch(() => {});
  }

  /** Attach (or reattach) the xterm host for the current id into the
   *  stage. Safe to call repeatedly; ensureSession is idempotent per
   *  id. Driven by a createEffect on id() so a restart (which swaps the
   *  tab id in place, without remounting the component) reconnects to
   *  the fresh PTY. */
  function attach() {
    if (!stage) return;
    const sess = ensureSession();
    if (sess.host.parentElement !== stage) {
      stage.appendChild(sess.host);
    }
    sess.host.style.display = "block";
    window.requestAnimationFrame(() => {
      fitAndResize(sess);
      sess.term.focus();
    });
  }

  createEffect(() => {
    // Track id() so a restart-driven id swap reattaches. Skip while the
    // dead overlay is up — the user must click Restart, which spawns a
    // new PTY and clears `dead`, at which point the new id attaches.
    const currentId = id();
    if (!currentId || dead()) return;
    attach();
  });

  onMount(() => {
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      const sess = cache.get(id());
      if (sess) fitAndResize(sess);
    });
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });

  return (
    <section data-testid="terminal-pane" class="flex flex-col h-full">
      <div class="relative flex-1 bg-bg-1" ref={(el) => (stage = el)} data-testid="term-stage">
        <Show when={dead()}>
          <div
            class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg-1/95 text-center px-4"
            data-testid="term-dead-overlay"
          >
            <p class="text-[13px] text-fg-muted">
              This terminal's session has ended.
              <br />
              <span class="text-[12px] text-fg-subtle">
                Its shell is no longer running (the backend may have restarted).
              </span>
            </p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="ag-btn ag-btn-primary ag-btn-sm"
                disabled={restarting()}
                onClick={() => void restart()}
                data-testid="term-restart"
              >
                {restarting() ? "Restarting…" : "↻ Restart shell"}
              </button>
              <button
                type="button"
                class="ag-btn ag-btn-sm"
                disabled={restarting()}
                onClick={() => void destroyTab()}
                data-testid="term-close-dead"
              >
                Close tab
              </button>
            </div>
          </div>
        </Show>
      </div>
    </section>
  );
}
