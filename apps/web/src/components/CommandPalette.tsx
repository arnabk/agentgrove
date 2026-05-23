import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { api } from "../api/client";
import { selectFile, state } from "../stores/app";

/**
 * VSCode-style Cmd+P fuzzy file finder.
 *
 * Opens via Cmd/Ctrl+P (or `setOpen(true)` for programmatic access).
 * Type to filter; ↑/↓ to navigate; Enter to open in the editor pane;
 * Esc to close. The BE handles indexing + matching (see
 * `crates/agentgrove-api/src/file_index.rs`); this component is a
 * thin presenter that debounces the query (16 ms) and renders the
 * top 50 hits.
 *
 * Empty query shows the first 50 indexed entries so the palette is
 * useful immediately — a fast way to browse the tree without typing.
 *
 * Scoped to `state.selectedProjectId`. With no project selected the
 * palette closes itself.
 */

interface Props {
  open: () => boolean;
  onClose: () => void;
}

interface Hit {
  path: string;
  abs: string;
  score: number;
}

export default function CommandPalette(props: Props) {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<Hit[]>([]);
  const [activeIdx, setActiveIdx] = createSignal(0);
  const [totalIndexed, setTotalIndexed] = createSignal(0);
  const [err, setErr] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  // Sequence guard: if the user types fast we'll fire multiple
  // searches in flight; only the most recent should land. Without
  // this an older request can "win" the race and clobber the UI.
  let seq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inputRef: HTMLInputElement | undefined;

  async function runSearch(q: string) {
    const pid = state.selectedProjectId;
    if (!pid) {
      setHits([]);
      setTotalIndexed(0);
      return;
    }
    const mine = ++seq;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.searchFiles(pid, q, 50);
      if (mine !== seq) return; // a newer call landed first
      setHits(res.hits);
      setTotalIndexed(res.total_indexed);
      setActiveIdx(0);
    } catch (e) {
      if (mine !== seq) return;
      setErr(e instanceof Error ? e.message : String(e));
      setHits([]);
    } finally {
      if (mine === seq) setLoading(false);
    }
  }

  function scheduleSearch(q: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    // One animation-frame is enough — matcher is cheap, network is
    // loopback. Heavier debounce (e.g. 100 ms) would noticeably
    // delay each keystroke against a sub-10 ms BE.
    debounceTimer = setTimeout(() => void runSearch(q), 16);
  }

  // First open / re-open: focus + reset state + kick off the empty-
  // query search so the palette shows tree contents immediately.
  createEffect(() => {
    if (!props.open()) return;
    setQuery("");
    setActiveIdx(0);
    setErr(null);
    void runSearch("");
    queueMicrotask(() => inputRef?.focus());
  });

  // Global keybind: Cmd/Ctrl+P toggles the palette. We attach it
  // OUTSIDE this component (in App.tsx) so the keybind works even
  // when the palette is closed; but we also listen here for
  // navigation keys while the palette is open.
  const onKey = (e: KeyboardEvent) => {
    if (!props.open()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const list = hits();
      if (list.length === 0) return;
      setActiveIdx((i) => (i + 1) % list.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const list = hits();
      if (list.length === 0) return;
      setActiveIdx((i) => (i - 1 + list.length) % list.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits()[activeIdx()];
      if (hit) open(hit);
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  function open(hit: Hit) {
    selectFile(hit.abs);
    props.onClose();
  }

  return (
    <Show when={props.open()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4"
        role="dialog"
        aria-modal="true"
        aria-label="Find file"
        data-testid="command-palette"
      >
        <div class="absolute inset-0 bg-black/60" onClick={() => props.onClose()} />
        <div class="relative w-full max-w-2xl bg-bg-1 border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
          <div class="px-3 py-2.5 border-b border-border">
            <input
              ref={(el) => (inputRef = el)}
              class="ag-input !text-[14px] !py-1.5"
              placeholder="Type a file name…  ↑↓ navigate · ⏎ open · Esc close"
              value={query()}
              onInput={(e) => {
                const v = e.currentTarget.value;
                setQuery(v);
                scheduleSearch(v);
              }}
              data-testid="command-palette-input"
              autocomplete="off"
              spellcheck={false}
            />
          </div>
          <Show when={err()}>
            <p class="px-4 py-2 text-[12px] text-danger" data-testid="command-palette-error">
              {err()}
            </p>
          </Show>
          <div class="flex-1 overflow-y-auto" data-testid="command-palette-results">
            <For
              each={hits()}
              fallback={
                <p class="px-4 py-6 text-center text-[12.5px] text-fg-subtle">
                  <Show when={loading()} fallback={query() ? "No matches." : "Loading index…"}>
                    Searching…
                  </Show>
                </p>
              }
            >
              {(hit, i) => (
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] font-mono hover:bg-bg-2"
                  classList={{ "!bg-accent-soft": i() === activeIdx() }}
                  onMouseEnter={() => setActiveIdx(i())}
                  onClick={() => open(hit)}
                  data-testid={`command-palette-hit-${i()}`}
                  title={hit.abs}
                >
                  <span class="truncate flex-1">{hit.path}</span>
                </button>
              )}
            </For>
          </div>
          <footer
            class="border-t border-border px-3 py-1.5 text-[11px] text-fg-subtle flex items-center justify-between"
            data-testid="command-palette-footer"
          >
            <span>
              {hits().length} of {totalIndexed()} file
              {totalIndexed() === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              class="ag-btn ag-btn-ghost ag-btn-sm text-[11px]"
              onClick={async () => {
                const pid = state.selectedProjectId;
                if (!pid) return;
                setLoading(true);
                try {
                  await api.reindexFiles(pid);
                  await runSearch(query());
                } finally {
                  setLoading(false);
                }
              }}
              title="Rescan project files"
              data-testid="command-palette-reindex"
            >
              ↻ rescan
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}
