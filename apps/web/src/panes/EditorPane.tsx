import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
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

export default function EditorPane() {
  let host!: HTMLDivElement;
  const langComp = new Compartment();
  const editableComp = new Compartment();
  const [openPath, setOpenPath] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);
  let view: EditorView | null = null;

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          oneDark,
          langComp.of([]),
          editableComp.of([EditorView.editable.of(false)]),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
          }),
        ],
      }),
    });
  });

  onCleanup(() => view?.destroy());

  async function loadPath(p: string) {
    setBusy(true);
    setLoadErr(null);
    try {
      const f = await api.readFile(p);
      setOpenPath(f.path);
      view?.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: f.content },
        effects: [
          langComp.reconfigure(langFor(f.path)),
          editableComp.reconfigure([EditorView.editable.of(true)]),
        ],
      });
      recordMemoryUsage("editor.document", f.content.length * 2);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Auto-open whenever the file explorer selection changes.
  createEffect(() => {
    const p = selectedFilePath();
    if (p && p !== openPath()) {
      void loadPath(p);
    } else if (!p && openPath() !== null) {
      // Selection cleared (e.g. project switch). Empty the buffer and
      // make the editor non-editable again.
      setOpenPath(null);
      view?.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        effects: [
          langComp.reconfigure([]),
          editableComp.reconfigure([EditorView.editable.of(false)]),
        ],
      });
      recordMemoryUsage("editor.document", 0);
    }
  });

  async function save() {
    const p = openPath();
    if (!p || !view) return;
    setBusy(true);
    try {
      await api.writeFile(p, view.state.doc.toString());
      setSaved(new Date().toLocaleTimeString());
    } finally {
      setBusy(false);
    }
  }

  createEffect(() => {
    setSaved(null);
    void openPath();
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
        <button
          class="ag-btn ag-btn-primary"
          onClick={save}
          disabled={!openPath() || busy()}
          data-testid="editor-save"
        >
          Save{" "}
          <span class="ag-kbd !bg-transparent !border-transparent text-[var(--ag-accent-fg)] opacity-80">
            ⌘S
          </span>
        </button>
        <Show when={saved()}>
          <span class="ag-chip ag-chip-success" data-testid="editor-saved-at">
            saved {saved()}
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
              <p>
                Pick a file in the project tree on the left to start editing.
              </p>
            </div>
          </div>
        </Show>
      </div>
    </section>
  );
}
