import { For, createEffect, createSignal } from "solid-js";
import { api, type Note } from "../api/client";
import { state } from "../stores/app";

export default function NotesPane() {
  const [notes, setNotes] = createSignal<Note[]>([]);
  const [body, setBody] = createSignal("");

  async function reload() {
    const id = state.selectedChatId;
    if (!id) {
      setNotes([]);
      return;
    }
    setNotes(await api.listNotes(id));
  }

  createEffect(() => {
    void state.selectedChatId;
    void reload();
  });

  async function add(ev: SubmitEvent) {
    ev.preventDefault();
    const id = state.selectedChatId;
    if (!id || !body().trim()) return;
    await api.addNote(id, body());
    setBody("");
    await reload();
  }

  async function remove(n: Note) {
    const id = state.selectedChatId;
    if (!id) return;
    await api.deleteNote(id, n.id);
    await reload();
  }

  return (
    <section data-testid="notes-pane" class="flex flex-col h-full">
      <header class="h-11 px-4 flex items-center border-b border-border bg-bg-1">
        <h2 class="text-[13px] font-semibold tracking-tight">Notes</h2>
      </header>
      <form
        onSubmit={add}
        class="px-4 py-3 border-b border-border bg-bg-1 flex gap-2"
        data-testid="notes-form"
      >
        <input
          class="ag-input"
          placeholder="Jot a quick note about this chat…"
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          disabled={!state.selectedChatId}
          data-testid="note-input"
        />
        <button
          type="submit"
          class="ag-btn ag-btn-primary"
          disabled={!state.selectedChatId || !body().trim()}
          data-testid="note-add"
        >
          Add
        </button>
      </form>
      <ul class="flex-1 overflow-y-auto p-4 space-y-2" data-testid="notes-list">
        <For
          each={notes()}
          fallback={<li class="text-center text-fg-subtle text-sm py-10">No notes yet.</li>}
        >
          {(n) => (
            <li
              class="group flex items-start gap-3 rounded-md bg-bg-1 border border-border px-3 py-2.5 text-[13px]"
              data-testid={`note-${n.id}`}
            >
              <span class="text-fg-subtle mt-0.5">✦</span>
              <span class="flex-1 whitespace-pre-wrap">{n.body}</span>
              <button
                class="ag-btn ag-btn-danger !py-0.5 !px-1.5 !text-[11px] opacity-0 group-hover:opacity-100"
                onClick={() => remove(n)}
                data-testid={`note-delete-${n.id}`}
              >
                delete
              </button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
