import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api/client";
import { confirm } from "../components/dialog";
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
import {
  addTerminalTab,
  closeTerminalTab,
  currentScope,
  setActiveTerminal,
  state,
  type TerminalTab,
} from "../stores/app";

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
  const [err, setErr] = createSignal<string | null>(null);
  const [spawning, setSpawning] = createSignal(false);
  // sessionId -> exited
  const [exitedMap, setExitedMap] = createStore<Record<string, boolean>>({});

  const scope = () => currentScope();
  const tabs = () => scope()?.terminals ?? [];
  const activeId = () => scope()?.activeTerminal ?? null;

  async function spawn() {
    const pid = state.selectedProjectId;
    if (!pid) return;
    setErr(null);
    setSpawning(true);
    try {
      const t = await api.createTerminal({
        cols: 80,
        rows: 24,
        project_id: pid,
      });
      const tab: TerminalTab = {
        id: t.id,
        cwd: t.cwd,
        label: `term ${tabs().length + 1}`,
      };
      const res = addTerminalTab(tab);
      if (!res.ok) setErr(res.reason ?? "could not open terminal");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSpawning(false);
    }
  }

  async function closeTab(id: string) {
    const ok = await confirm({
      title: "Close terminal",
      body: "Kill this terminal session? The shell process will end.",
      confirmLabel: "Close",
      danger: true,
      testId: "confirm-close-terminal",
    });
    if (!ok) return;
    // Tear down cached session.
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
    setExitedMap(id, undefined as unknown as boolean);
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
    void (async () => {
      let tick = 0;
      while (!poll.stop) {
        try {
          const h = await api.terminalHistory(id);
          if (h.length > session.lastBytes) {
            term.write(h.slice(session.lastBytes));
            session.lastBytes = h.length;
            reportTerminalBytes(cache);
          }
        } catch {
          break;
        }
        // Poll status every ~1s (every 5 history ticks).
        if (tick % 5 === 0) {
          try {
            const s = await api.terminalStatus(id);
            setExitedMap(id, s.exited);
          } catch {
            // session gone server-side; stop polling
            break;
          }
        }
        tick += 1;
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
        try {
          sess.fit.fit();
        } catch {
          /* not sized yet */
        }
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
      <header class="h-11 px-3 flex items-center gap-1.5 border-b border-border bg-bg-1 overflow-x-auto">
        <For each={tabs()}>
          {(t) => (
            <div
              class="group inline-flex items-center gap-1 rounded-md border border-border bg-bg-2 pl-2 pr-1 py-1 text-[12px] cursor-pointer"
              classList={{
                "!border-accent !bg-accent-soft": t.id === activeId(),
                "hover:bg-bg-3": t.id !== activeId(),
                "opacity-70": exitedMap[t.id] === true,
              }}
              onClick={() => setActiveTerminal(t.id)}
              title={`${t.label} · ${t.cwd}${exitedMap[t.id] ? " · exited" : ""}`}
              data-testid={`term-tab-${t.id}`}
            >
              <span class="font-mono">{t.label}</span>
              <Show when={exitedMap[t.id]}>
                <span
                  class="ml-1 px-1.5 py-px rounded-sm bg-bg-3 text-fg-subtle text-[10px] uppercase tracking-wide"
                  data-testid={`term-exited-${t.id}`}
                >
                  exited
                </span>
              </Show>
              <button
                type="button"
                class="ml-1 px-1 text-fg-subtle hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(t.id);
                }}
                aria-label={`Close ${t.label}`}
                data-testid={`term-close-${t.id}`}
                title="Close terminal"
              >
                ✕
              </button>
            </div>
          )}
        </For>
        <button
          class="ag-btn ag-btn-ghost ag-btn-sm ml-1"
          onClick={spawn}
          disabled={spawning() || !state.selectedProjectId}
          title="New terminal"
          data-testid="term-spawn"
        >
          + New
        </button>
        <Show when={err()}>
          <span
            class="ml-auto text-[11.5px] text-danger"
            data-testid="term-error"
            title={err() ?? ""}
          >
            {err()}
          </span>
        </Show>
      </header>
      <div
        class="relative flex-1 bg-bg-1"
        ref={(el) => (stage = el)}
        data-testid="term-stage"
      >
        <Show when={tabs().length === 0}>
          <div class="absolute inset-0 flex items-center justify-center text-fg-subtle text-[13px]">
            Click <span class="mx-1 ag-kbd">+ New</span> to open a terminal in this project.
          </div>
        </Show>
      </div>
    </section>
  );
}
