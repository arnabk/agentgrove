import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api/client";

export default function TerminalPane() {
  let host!: HTMLDivElement;
  const [termId, setTermId] = createSignal<string | null>(null);
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let stopPoll = false;

  async function spawn() {
    const t = await api.createTerminal({ cols: 80, rows: 24 });
    setTermId(t.id);
    pollHistory(t.id);
  }

  function pollHistory(id: string) {
    let last = 0;
    const loop = async () => {
      while (!stopPoll) {
        try {
          const h = await api.terminalHistory(id);
          if (h.length > last && term) {
            term.write(h.slice(last));
            last = h.length;
          }
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    void loop();
  }

  onMount(() => {
    term = new Terminal({
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
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      // host may not be sized yet
    }
    term.onData((d) => {
      const id = termId();
      if (id) void api.writeTerminal(id, d);
    });
  });

  onCleanup(() => {
    stopPoll = true;
    term?.dispose();
    const id = termId();
    if (id) void api.killTerminal(id);
  });

  return (
    <section data-testid="terminal-pane" class="flex flex-col h-full">
      <header class="h-11 px-3 flex items-center gap-2 border-b border-border bg-bg-1">
        <button
          class="ag-btn ag-btn-primary"
          onClick={spawn}
          disabled={!!termId()}
          data-testid="term-spawn"
        >
          ❯_ {termId() ? "Running" : "Open terminal"}
        </button>
        <Show when={termId()}>
          <span class="ag-chip font-mono">{termId()!.slice(0, 8)}</span>
          <span class="ag-chip ag-chip-success">live</span>
        </Show>
      </header>
      <div ref={(el) => (host = el)} class="flex-1 bg-bg-1" data-testid="term-host" />
    </section>
  );
}
