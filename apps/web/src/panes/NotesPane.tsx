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
      <header class="px-4 py-2 border-b border-[var(--ag-muted)]">
        <h2 class="font-semibold">Notes</h2>
      </header>
      <form
        onSubmit={add}
        class="p-3 border-b border-[var(--ag-muted)] flex gap-2"
        data-testid="notes-form"
      >
        <input
          class="flex-1 px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
          placeholder="Note something for this chat..."
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          disabled={!state.selectedChatId}
          data-testid="note-input"
        />
        <button
          type="submit"
          class="px-3 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
          disabled={!state.selectedChatId}
          data-testid="note-add"
        >
          Add
        </button>
      </form>
      <ul class="flex-1 overflow-y-auto p-3 space-y-2" data-testid="notes-list">
        <For each={notes()}>
          {(n) => (
            <li
              class="flex items-start gap-2 border border-[var(--ag-muted)] rounded p-2 text-sm"
              data-testid={`note-${n.id}`}
            >
              <span class="flex-1">{n.body}</span>
              <button
                class="text-xs text-red-400"
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
