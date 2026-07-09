import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { foldGutter, foldKeymap, codeFolding, indentOnInput } from "@codemirror/language";
import { editorTheme } from "../lib/codemirrorTheme";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { api } from "../api/client";
import { declareMemorySource, recordMemoryUsage } from "../lib/memory";
import { selectedFilePath } from "../stores/app";

declareMemorySource("editor.document", "Editor document");

function langFor(path: string): Extension {
  if (path.endsWith(".rs")) return rust();
  if (path.endsWith(".json")) return json();
  if (path.endsWith(".md")) return markdown();
  if (/\.(ts|tsx|js|jsx)$/.test(path)) return javascript({ jsx: true, typescript: true });
  return javascript({ typescript: true });
}

/** Autosave debounce. Edits within this window after a previous edit
 *  coalesce into a single write. */
const AUTOSAVE_DEBOUNCE_MS = 600;

/**
 * Editor pane with **autosave**.
 *
 * Saving happens automatically:
 *
 *   - 600 ms after the last keystroke (debounced)
 *   - immediately before switching to a different file
 *   - immediately on window blur (so closing the tab is safe)
 *   - on Cmd/Ctrl+S (still useful for users who want to force a
 *     flush; we just acknowledge the keystroke)
 *
 * The Save button is gone. The header shows the open path and a
 * subtle "saving…" / "saved Xs ago" indicator instead.
 */
export default function EditorPane() {
  let host!: HTMLDivElement;
  const langComp = new Compartment();
  const editableComp = new Compartment();
  const [openPath, setOpenPath] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<Date | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);
  let view: EditorView | null = null;
  /** Path the editor's current buffer belongs to. Distinct from
   *  `openPath()` so writes can target the correct file even if the
   *  user has already started switching to a new one. */
  let bufferPath: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // True while we're loading content into the view (so the
  // updateListener that fires from our own dispatch doesn't think
  // the user edited anything).
  let loading = false;

  /** Persist the editor's current contents. Used by the debounced
   *  timer, file-switch, blur, and explicit Cmd/Ctrl+S. */
  async function flush() {
    if (!view) return;
    const p = bufferPath;
    if (!p) return;
    if (!dirty()) return;
    setSaving(true);
    try {
      const content = view.state.doc.toString();
      await api.writeFile(p, content);
      setDirty(false);
      setSavedAt(new Date());
      recordMemoryUsage("editor.document", content.length * 2);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /** Schedule a debounced flush. Cancels any pending timer first. */
  function scheduleFlush() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          // Code folding: ▸/▾ markers in their own gutter next to the
          // line numbers. Folding ranges are computed by the active
          // language extension's syntax tree, so JS/TS/JSON/Markdown/
          // Rust all "just work" — and the markers stay empty for
          // plain-text files (no false positives). Mod-Alt-[/]/.
          // shortcuts come from `foldKeymap`.
          codeFolding(),
          foldGutter(),
          indentOnInput(),
          history(),
          keymap.of([
            // Force-flush save shortcut (no-op for autosave but
            // satisfies the muscle memory).
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                void flush();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
          ]),
          editorTheme,
          langComp.of([]),
          editableComp.of([EditorView.editable.of(false)]),
          EditorView.updateListener.of((u) => {
            if (loading) return;
            if (u.docChanged) {
              setDirty(true);
              scheduleFlush();
            }
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "var(--ag-font-size, 15px)" },
            ".cm-scroller": { fontFamily: "var(--ag-font-mono)" },
            ".cm-content": { fontFamily: "var(--ag-font-mono)" },
          }),
        ],
      }),
    });

    // Save when the window loses focus / before unload so unsaved
    // edits don't disappear if the user closes the tab.
    const onBlur = () => {
      if (dirty()) void flush();
    };
    window.addEventListener("blur", onBlur);
    onCleanup(() => window.removeEventListener("blur", onBlur));
  });

  onCleanup(() => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    // Best-effort final flush before tearing the view down.
    if (dirty()) void flush();
    view?.destroy();
  });

  async function loadPath(p: string) {
    // If there are unsaved changes on the *current* buffer, flush
    // them synchronously before swapping in the new file so edits
    // aren't lost during a fast click-through in the file tree.
    if (dirty() && bufferPath && bufferPath !== p) {
      await flush();
    }
    setLoadErr(null);
    try {
      const f = await api.readFile(p);
      loading = true;
      try {
        setOpenPath(f.path);
        bufferPath = f.path;
        view?.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: f.content },
          effects: [
            langComp.reconfigure(langFor(f.path)),
            editableComp.reconfigure([EditorView.editable.of(true)]),
          ],
        });
      } finally {
        loading = false;
      }
      setDirty(false);
      setSavedAt(new Date());
      recordMemoryUsage("editor.document", f.content.length * 2);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Auto-open whenever the file explorer selection changes.
  createEffect(() => {
    const p = selectedFilePath();
    if (p && p !== openPath()) {
      void loadPath(p);
    } else if (!p && openPath() !== null) {
      // Selection cleared (e.g. project switch). Flush pending edits
      // first, then empty the buffer.
      void (async () => {
        if (dirty() && bufferPath) await flush();
        loading = true;
        try {
          setOpenPath(null);
          bufferPath = null;
          view?.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: "" },
            effects: [
              langComp.reconfigure([]),
              editableComp.reconfigure([EditorView.editable.of(false)]),
            ],
          });
        } finally {
          loading = false;
        }
        setDirty(false);
        recordMemoryUsage("editor.document", 0);
      })();
    }
  });

  /** Human-friendly "saved 5s ago" / "saving…" / "modified" hint. */
  function statusLabel(): string {
    if (saving()) return "saving…";
    if (dirty()) return "modified";
    const t = savedAt();
    if (!t) return "";
    const dt = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000));
    if (dt < 3) return "saved";
    if (dt < 60) return `saved ${dt}s ago`;
    return `saved ${Math.floor(dt / 60)}m ago`;
  }
  // Re-tick the status label every 5 s so "5s ago" stays current.
  // We DO read the signal (inside `savedLabel` callers via the
  // tracking scope below) so destructure both halves; the
  // solid/reactivity lint rule prefers a named first slot.
  const [tick, setTick] = createSignal(0);
  // Touch `tick()` so the surrounding tracked scope re-runs on
  // every interval — that's the whole point of the ticker.
  void tick;
  createEffect(() => {
    if (!savedAt()) return;
    const id = setInterval(() => setTick((n) => n + 1), 5000);
    onCleanup(() => clearInterval(id));
  });

  return (
    <section data-testid="editor-pane" class="flex flex-col h-full">
      <header class="h-11 px-3 flex items-center gap-2 border-b border-border bg-bg-1">
        <div
          class="flex-1 min-w-0 text-[12.5px] font-mono truncate"
          classList={{
            "text-fg-muted": !!openPath(),
            "text-fg-subtle italic": !openPath(),
          }}
          title={openPath() ?? ""}
          data-testid="editor-path"
        >
          {openPath() ?? "No file selected"}
        </div>
        <Show when={openPath()}>
          <span
            class="ag-chip text-[11px]"
            classList={{
              "ag-chip-success": !dirty() && !saving() && !!savedAt(),
              "text-fg-subtle": dirty() || saving(),
            }}
            data-testid="editor-status"
            title={
              dirty()
                ? "Unsaved edits — autosaves shortly"
                : saving()
                  ? "Saving…"
                  : "All changes saved"
            }
          >
            {statusLabel()}
          </span>
        </Show>
      </header>
      <Show when={loadErr()}>
        <div
          class="px-3 py-1.5 text-[12px] text-danger border-b border-border bg-bg-1"
          data-testid="editor-error"
        >
          {loadErr()}
        </div>
      </Show>
      <div class="relative flex-1">
        <div
          ref={(el) => (host = el)}
          class="absolute inset-0"
          classList={{ "opacity-40 pointer-events-none": !openPath() }}
          aria-disabled={!openPath()}
          data-testid="editor-host"
        />
        <Show when={!openPath()}>
          <div
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
            data-testid="editor-empty-state"
          >
            <div class="text-center text-fg-subtle text-[13px] max-w-sm px-6">
              <p class="font-medium text-fg-muted mb-1">No file open</p>
              <p>Pick a file in the project tree on the left to start editing.</p>
            </div>
          </div>
        </Show>
      </div>
    </section>
  );
}
