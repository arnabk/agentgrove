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
  const [path, setPath] = createSignal("");
  const [openPath, setOpenPath] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
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
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
          }),
        ],
      }),
    });
  });

  onCleanup(() => view?.destroy());

  async function open(ev: SubmitEvent) {
    ev.preventDefault();
    const p = path().trim();
    if (!p) return;
    setBusy(true);
    try {
      const f = await api.readFile(p);
      setOpenPath(f.path);
      view?.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: f.content },
        effects: langComp.reconfigure(langFor(f.path)),
      });
    } finally {
      setBusy(false);
    }
  }

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
        <form onSubmit={open} class="flex-1 flex gap-2" data-testid="editor-open-form">
          <input
            class="ag-input font-mono"
            placeholder="/absolute/path/to/file"
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            data-testid="editor-path"
          />
          <button
            type="submit"
            class="ag-btn ag-btn-secondary"
            disabled={busy()}
            data-testid="editor-open"
          >
            Open
          </button>
        </form>
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
      <div ref={(el) => (host = el)} class="flex-1" data-testid="editor-host" />
    </section>
  );
}
