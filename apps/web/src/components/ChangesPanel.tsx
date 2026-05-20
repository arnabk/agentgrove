import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { MergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { api, type GitStatusEntry } from "../api/client";
import { changesScope, setChangesScope } from "../stores/app";

/**
 * Right-side slide-in panel showing the git status for the active
 * scope (project root or worktree path). Two groups — staged and
 * unstaged — list entries; selecting a file loads a side-by-side
 * MergeView (HEAD vs working tree) below.
 *
 * Mounted at the App-shell level and shown whenever `changesScope` is
 * non-null. Closing it sets `changesScope(null)`.
 */
export default function ChangesPanel() {
  const [entries, setEntries] = createSignal<GitStatusEntry[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let view: MergeView | null = null;

  async function refresh() {
    const scope = changesScope();
    if (!scope) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.gitStatus(scope.path);
      setEntries(res.entries);
      // Keep selection if it's still in the list.
      if (selected() && !res.entries.find((e) => e.path === selected())) {
        setSelected(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  function tearDownView() {
    if (view) {
      view.destroy();
      view = null;
    }
    if (host) host.innerHTML = "";
  }

  async function openDiff(filePath: string) {
    const scope = changesScope();
    if (!scope) return;
    setSelected(filePath);
    // Absolute path expected by /api/editor/diff. Filepath is relative
    // to the scope root; join manually.
    const sep = scope.path.endsWith("/") ? "" : "/";
    const abs = `${scope.path}${sep}${filePath}`;
    try {
      const d = await api.fileDiff(abs);
      tearDownView();
      if (!host) return;
      view = new MergeView({
        parent: host,
        a: { doc: d.head, extensions: [oneDark, EditorView.editable.of(false)] },
        b: { doc: d.working, extensions: [oneDark, EditorView.editable.of(false)] },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  onMount(() => void refresh());

  // Refresh whenever the scope changes (e.g. user switches projects
  // while the panel is open).
  createEffect(() => {
    void changesScope();
    tearDownView();
    setSelected(null);
    void refresh();
  });

  onCleanup(() => tearDownView());

  // Group entries by stage (x != ' ') vs unstaged.
  const staged = () => entries().filter((e) => e.x !== " " && e.x !== "?");
  const unstaged = () => entries().filter((e) => e.y !== " " || e.x === "?");

  function statusLabel(e: GitStatusEntry): string {
    if (e.untracked) return "U";
    if (e.renamed) return "R";
    if (e.added) return "A";
    if (e.deleted) return "D";
    if (e.modified) return "M";
    return `${e.x}${e.y}`.trim() || "·";
  }

  return (
    <div
      class="fixed inset-0 z-40 flex justify-end"
      data-testid="changes-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Changes"
    >
      <div
        class="absolute inset-0 bg-black/40"
        onClick={() => setChangesScope(null)}
      />
      <aside class="relative w-[min(960px,90vw)] h-full bg-bg-1 border-l border-border shadow-2xl flex flex-col">
        <header class="h-11 px-4 flex items-center gap-2 border-b border-border bg-bg-1">
          <h3 class="text-[13.5px] font-semibold tracking-tight">Changes</h3>
          <Show when={changesScope()}>
            <span class="ag-chip ag-chip-accent font-mono" data-testid="changes-scope">
              {changesScope()!.label}
            </span>
          </Show>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm ml-auto"
            onClick={() => void refresh()}
            disabled={loading()}
            title="Refresh"
            data-testid="changes-refresh"
          >
            ↻
          </button>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => setChangesScope(null)}
            aria-label="Close changes panel"
            data-testid="changes-close"
          >
            ✕
          </button>
        </header>

        <Show when={err()}>
          <p class="px-4 py-2 text-[12px] text-danger" data-testid="changes-error">
            {err()}
          </p>
        </Show>

        <div class="flex-1 grid grid-cols-[280px,1fr] min-h-0">
          {/* File list */}
          <div class="border-r border-border overflow-y-auto">
            <Section title="Staged" items={staged()} statusLabel={statusLabel}
              selected={selected()} onSelect={(p) => void openDiff(p)} />
            <Section title="Unstaged" items={unstaged()} statusLabel={statusLabel}
              selected={selected()} onSelect={(p) => void openDiff(p)} />
            <Show when={!loading() && entries().length === 0}>
              <p
                class="text-center text-[12.5px] text-fg-subtle py-6 px-3"
                data-testid="changes-empty"
              >
                Working tree clean.
              </p>
            </Show>
          </div>

          {/* Diff host */}
          <div class="overflow-auto" ref={(el) => (host = el)} data-testid="changes-diff-host">
            <Show when={!selected()}>
              <div class="h-full flex items-center justify-center text-[12.5px] text-fg-subtle px-6 text-center">
                Select a file on the left to view its diff against HEAD.
              </div>
            </Show>
          </div>
        </div>
      </aside>
    </div>
  );
}

interface SectionProps {
  title: string;
  items: GitStatusEntry[];
  selected: string | null;
  statusLabel: (e: GitStatusEntry) => string;
  onSelect: (path: string) => void;
}

function Section(props: SectionProps) {
  return (
    <Show when={props.items.length > 0}>
      <div class="py-1">
        <div class="px-3 py-1 text-[10.5px] uppercase tracking-wider text-fg-subtle">
          {props.title} · {props.items.length}
        </div>
        <ul>
          <For each={props.items}>
            {(e) => (
              <li>
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-bg-2 text-[12.5px] font-mono"
                  classList={{ "!bg-accent-soft": props.selected === e.path }}
                  onClick={() => props.onSelect(e.path)}
                  data-testid={`changes-row-${e.path}`}
                  title={e.path}
                >
                  <span class="w-5 text-[11px] text-fg-subtle text-center">
                    {props.statusLabel(e)}
                  </span>
                  <span class="truncate">{e.path}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
