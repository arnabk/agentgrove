import { createSignal, onCleanup, onMount } from "solid-js";
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
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    void loop();
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: { background: "#0b0d10" },
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
      <header class="px-4 py-2 border-b border-[var(--ag-muted)] flex items-center gap-2">
        <button
          class="px-3 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
          onClick={spawn}
          disabled={!!termId()}
          data-testid="term-spawn"
        >
          {termId() ? `Session ${termId()!.slice(0, 8)}…` : "Open terminal"}
        </button>
      </header>
      <div ref={(el) => (host = el)} class="flex-1" data-testid="term-host" />
    </section>
  );
}
