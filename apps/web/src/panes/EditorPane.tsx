import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
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
  let view: EditorView | null = null;

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "// Open a file to begin editing.",
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          oneDark,
          langComp.of([]),
          EditorView.theme({ "&": { height: "100%", fontSize: "13px" } }),
        ],
      }),
    });
  });

  onCleanup(() => view?.destroy());

  async function open(ev: SubmitEvent) {
    ev.preventDefault();
    const p = path().trim();
    if (!p) return;
    const f = await api.readFile(p);
    setOpenPath(f.path);
    view?.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: f.content },
      effects: langComp.reconfigure(langFor(f.path)),
    });
  }

  async function save() {
    const p = openPath();
    if (!p || !view) return;
    const content = view.state.doc.toString();
    await api.writeFile(p, content);
    setSaved(new Date().toLocaleTimeString());
  }

  createEffect(() => {
    setSaved(null);
    void openPath();
  });

  return (
    <section data-testid="editor-pane" class="flex flex-col h-full">
      <header class="px-4 py-2 border-b border-[var(--ag-muted)] flex items-center gap-2">
        <form onSubmit={open} class="flex-1 flex gap-2" data-testid="editor-open-form">
          <input
            class="flex-1 px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
            placeholder="absolute file path"
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            data-testid="editor-path"
          />
          <button
            type="submit"
            class="px-3 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
            data-testid="editor-open"
          >
            Open
          </button>
        </form>
        <button
          class="px-3 py-1 rounded border border-[var(--ag-muted)] text-sm"
          onClick={save}
          disabled={!openPath()}
          data-testid="editor-save"
        >
          Save
        </button>
        {saved() && (
          <span class="text-xs text-emerald-400" data-testid="editor-saved-at">
            saved {saved()}
          </span>
        )}
      </header>
      <div ref={(el) => (host = el)} class="flex-1" data-testid="editor-host" />
    </section>
  );
}
