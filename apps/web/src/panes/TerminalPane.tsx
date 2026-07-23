import { onCleanup, onMount } from "solid-js";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { api, openTerminalWs } from "../api/client";
import { declareMemorySource, recordMemoryUsage } from "../lib/memory";

declareMemorySource("terminal.scrollback", "Terminal scrollback");

function reportTerminalBytes(cache: Map<string, { lastBytes: number }>) {
  let total = 0;
  for (const sess of cache.values()) total += sess.lastBytes * 2;
  recordMemoryUsage("terminal.scrollback", total);
}
import { closeTerminalTab } from "../stores/app";

interface CachedSession {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  ws: WebSocket | null;
  closing: boolean;
  lastBytes: number;
}

const cache = new Map<string, CachedSession>();

interface Props {
  terminalId: string;
}

export default function TerminalPane(props: Props) {
  let stage!: HTMLDivElement;

  const id = () => props.terminalId;

  async function destroyTab() {
    const c = cache.get(id());
    if (c) {
      c.closing = true;
      try {
        c.ws?.close();
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

  function ensureSession(): CachedSession {
    const found = cache.get(id());
    if (found) return found;
    const host = document.createElement("div");
    host.style.position = "absolute";
    host.style.inset = "0";
    host.style.display = "none";
    host.dataset.testid = `term-${id()}`;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      // Required by the unicode11 addon (its width tables are a
      // "proposed API" surface in xterm.js).
      allowProposedApi: true,
      theme: {
        background: "var(--ag-bg-1)" as unknown as string,
        foreground: "#e8ecf2",
        cursor: "#7c5cff",
      },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Unicode 11 width tables so zsh's wcwidth math (fancy prompts with
    // ☁/⚡-style glyphs) matches what we render — the default table
    // mis-measures these, which shifts every wrapped-line repaint a
    // cell or two and leaves ghost fragments behind.
    term.loadAddon(new Unicode11Addon());
    // WebGL renderer where available — full-cell repaints are more
    // faithful for wrapped-line redraws than the DOM renderer. Falls
    // back to the default renderer when WebGL is unavailable.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // no WebGL — default renderer is fine
    }
    term.open(host);

    const session: CachedSession = {
      term,
      fit,
      host,
      ws: null,
      closing: false,
      lastBytes: 0,
    };
    cache.set(id(), session);
    return session;
  }

  /** Attach the output stream. Deliberately called only AFTER the
   *  first fit+resize: connecting earlier replays history and streams
   *  live output while the PTY is still at its 80x24 spawn size and
   *  the pane is already wider/narrower — zsh's repaint math and
   *  xterm's wrap model diverge in that window and stale fragments
   *  linger on screen (the "ghost text" artifacts). */
  function attachWs(sess: CachedSession) {
    if (sess.ws) return;
    const ws = openTerminalWs(id());
    sess.ws = ws;

    const currentId = id();
    sess.term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(d);
      } else {
        void api.writeTerminal(currentId, d);
      }
    });

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as { exited?: boolean };
          if (msg.exited) void destroyTab();
        } catch {
          // ignore
        }
        return;
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      sess.term.write(bytes);
      sess.lastBytes += bytes.byteLength;
      reportTerminalBytes(cache);
    };

    ws.onclose = () => {
      if (!sess.closing) void destroyTab();
    };
  }

  function fitAndResize(sess: CachedSession) {
    try {
      sess.fit.fit();
    } catch {
      return;
    }
    sess.term.scrollToBottom();
    const cols = sess.term.cols;
    const rows = sess.term.rows;
    void api.resizeTerminal(id(), cols, rows).catch(() => {});
  }

  onMount(() => {
    const sess = ensureSession();
    if (sess.host.parentElement !== stage) {
      stage.appendChild(sess.host);
    }
    sess.host.style.display = "block";
    window.requestAnimationFrame(() => {
      fitAndResize(sess);
      attachWs(sess);
      sess.term.focus();
    });
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
      <div
        class="relative flex-1 bg-bg-1"
        ref={(el) => (stage = el)}
        data-testid="term-stage"
      ></div>
    </section>
  );
}
