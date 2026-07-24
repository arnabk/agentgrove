import { onCleanup, onMount } from "solid-js";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
  ws: WebSocket;
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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const ws = openTerminalWs(id());
    const session: CachedSession = { term, fit, host, ws, closing: false, lastBytes: 0 };
    cache.set(id(), session);

    const currentId = id();
    term.onData((d) => {
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
      term.write(bytes);
      session.lastBytes += bytes.byteLength;
      reportTerminalBytes(cache);
    };

    ws.onclose = () => {
      if (!session.closing) void destroyTab();
    };

    return session;
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
