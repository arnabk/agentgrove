import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { api, type GitStatusEntry } from "../api/client";
import { changesScope, setChangesScope } from "../stores/app";
import { confirm } from "./dialog";

/**
 * Right-side slide-in panel showing the git status for the active
 * scope (project root or worktree path). Two groups — staged and
 * unstaged — list entries; selecting a file loads a side-by-side
 * MergeView (HEAD vs working tree) below.
 *
 * Mounted at the App-shell level and shown whenever `changesScope` is
 * non-null. Closing it sets `changesScope(null)`.
 */
/** Persisted toggle for soft-wrapping long lines in the diff view. */
const WRAP_LS_KEY = "ag-changes-wrap";

export default function ChangesPanel() {
  const [entries, setEntries] = createSignal<GitStatusEntry[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [wrap, setWrap] = createSignal(localStorage.getItem(WRAP_LS_KEY) !== "0");
  let host: HTMLDivElement | undefined;
  let view: MergeView | null = null;

  function commonExts() {
    const exts = [
      oneDark,
      lineNumbers(),
      EditorView.editable.of(false),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { fontFamily: "var(--ag-font-mono)" },
      }),
    ];
    if (wrap()) exts.push(EditorView.lineWrapping);
    return exts;
  }

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
        a: { doc: d.head, extensions: commonExts() },
        b: { doc: d.working, extensions: commonExts() },
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

  // Rebuild the diff view when the wrap toggle changes so the new
  // extensions take effect. CodeMirror MergeView extensions are
  // immutable once attached; the cheapest reliable refresh is to
  // recreate it.
  createEffect(() => {
    void wrap();
    const sel = selected();
    if (sel) void openDiff(sel);
  });

  onCleanup(() => tearDownView());

  /** Discard the working-tree changes for a single file (VSCode-style
   *  per-row Discard action). Restores tracked files from HEAD,
   *  deletes untracked files from disk. Destructive — gated behind a
   *  themed confirm with the precise wording tailored to each case.
   *  After the BE call we refresh the entries list and tear down the
   *  diff view if the just-discarded file was the one being viewed. */
  async function discardFile(entry: GitStatusEntry, ev: MouseEvent) {
    ev.stopPropagation();
    const scope = changesScope();
    if (!scope) return;
    const isUntracked = entry.untracked;
    const ok = await confirm({
      title: isUntracked ? "Delete file" : "Discard changes",
      body: isUntracked ? (
        <div>
          Delete the untracked file{" "}
          <code class="font-mono">{entry.path}</code> from disk? This
          cannot be undone.
        </div>
      ) : (
        <div>
          Discard all changes in{" "}
          <code class="font-mono">{entry.path}</code>? The file will be
          restored to its HEAD revision.
        </div>
      ),
      confirmLabel: isUntracked ? "Delete" : "Discard",
      danger: true,
      testId: "confirm-discard-file",
    });
    if (!ok) return;
    try {
      await api.gitDiscard(scope.path, entry.path);
      // If we were viewing this file's diff, tear it down — there's
      // nothing to diff against once the file is back at HEAD (or
      // gone). The next select() rebuilds the view as needed.
      if (selected() === entry.path) {
        tearDownView();
        setSelected(null);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

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
            classList={{ "!bg-bg-3 !text-fg": wrap() }}
            onClick={() => {
              const next = !wrap();
              setWrap(next);
              localStorage.setItem(WRAP_LS_KEY, next ? "1" : "0");
            }}
            title={wrap() ? "Disable line wrapping" : "Enable line wrapping"}
            aria-pressed={wrap()}
            data-testid="changes-wrap"
          >
            ↩ wrap
          </button>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
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
              selected={selected()} onSelect={(p) => void openDiff(p)}
              onDiscard={(e, ev) => void discardFile(e, ev)} />
            <Section title="Unstaged" items={unstaged()} statusLabel={statusLabel}
              selected={selected()} onSelect={(p) => void openDiff(p)}
              onDiscard={(e, ev) => void discardFile(e, ev)} />
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
  /** Per-row discard handler. Receives the entry + the mouse event
   *  (the button stops propagation so the row's onSelect doesn't also
   *  fire when the user clicks the discard icon). */
  onDiscard: (entry: GitStatusEntry, ev: MouseEvent) => void;
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
              <li class="group relative">
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-1 pr-8 text-left hover:bg-bg-2 text-[12.5px] font-mono"
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
                {/* Per-row discard icon. Reveals on hover so the
                    file list stays clean; absolutely positioned so it
                    overlays the row's right edge without taking flex
                    width from the path label. The button is OUTSIDE
                    the row button to avoid nested-button semantics. */}
                <button
                  type="button"
                  class="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-fg-subtle hover:text-danger hover:bg-bg-2"
                  onClick={(ev) => props.onDiscard(e, ev)}
                  aria-label={
                    e.untracked
                      ? `Delete untracked file ${e.path}`
                      : `Discard changes in ${e.path}`
                  }
                  title={e.untracked ? "Delete untracked file" : "Discard changes"}
                  data-testid={`changes-discard-${e.path}`}
                >
                  <DiscardIcon />
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

/** Lucide-style "undo" / counter-clockwise arrow. Matches VSCode's
 *  Discard glyph closely enough to read without a label. Em-sized so
 *  it scales with --ag-font-size. */
function DiscardIcon() {
  return (
    <svg width="0.95em" height="0.95em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7v6h6M3.51 15a9 9 0 1 0 2.13-9.36L3 8"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
