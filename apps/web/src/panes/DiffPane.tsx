import { createSignal, onCleanup } from "solid-js";
import { MergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { api } from "../api/client";

export default function DiffPane() {
  let host!: HTMLDivElement;
  const [path, setPath] = createSignal("");
  const [loaded, setLoaded] = createSignal<string | null>(null);
  let view: MergeView | null = null;

  async function open(ev: SubmitEvent) {
    ev.preventDefault();
    const p = path().trim();
    if (!p) return;
    const d = await api.fileDiff(p);
    setLoaded(p);
    view?.destroy();
    host.innerHTML = "";
    view = new MergeView({
      parent: host,
      a: {
        doc: d.head,
        extensions: [oneDark, EditorView.editable.of(false)],
      },
      b: {
        doc: d.working,
        extensions: [oneDark, EditorView.editable.of(false)],
      },
    });
  }

  onCleanup(() => view?.destroy());

  return (
    <section data-testid="diff-pane" class="flex flex-col h-full">
      <header class="px-4 py-2 border-b border-[var(--ag-muted)] flex items-center gap-2">
        <form onSubmit={open} class="flex-1 flex gap-2">
          <input
            class="flex-1 px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
            placeholder="absolute file path"
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            data-testid="diff-path"
          />
          <button
            type="submit"
            class="px-3 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
            data-testid="diff-open"
          >
            Diff vs HEAD
          </button>
        </form>
        {loaded() && (
          <span class="text-xs text-[var(--ag-muted)]" data-testid="diff-loaded">
            {loaded()}
          </span>
        )}
      </header>
      <div ref={(el) => (host = el)} class="flex-1 overflow-auto" data-testid="diff-host" />
    </section>
  );
}
