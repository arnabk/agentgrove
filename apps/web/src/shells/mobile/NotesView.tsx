import { Show } from "solid-js";
import NotesPane, {
  EyeIcon,
  EyeOffIcon,
  NotesDivider,
  NotesToolBtn,
  RedoIcon,
  SectionIcon,
  TaskListIcon,
  UndoIcon,
  notesActions,
  notesErr,
  notesSaving,
  notesSelVersion,
  notesTaskCounts,
  setShowDone,
  showDone,
} from "@/features/notes/NotesPane";

/**
 * Notes with a compact toolbar.
 *
 * The desktop toolbar lives in the right sidebar's header, which the
 * mobile shell doesn't have — so the same controls are rendered here in
 * a single row above the editor. `notesSelVersion()` is read so the
 * active-state highlights re-render on every selection change.
 */
export default function NotesView() {
  return (
    <div class="flex h-full flex-col" data-testid="mobile-notes">
      <div class="flex h-11 shrink-0 items-center gap-0.5 border-b border-border bg-bg-2 pl-3 pr-2">
        <Show when={notesSaving()}>
          <span class="text-[10px] text-fg-subtle" data-testid="notes-saving">
            saving…
          </span>
        </Show>
        <Show when={notesErr()}>
          <span class="text-[10px] text-danger" data-testid="notes-error" title={notesErr() ?? ""}>
            save failed
          </span>
        </Show>

        <div class="ml-auto flex items-center gap-0.5">
          <NotesToolBtn
            label={<TaskListIcon />}
            title="Todo item"
            active={(notesSelVersion(), notesActions()?.isActive("taskList"))}
            onClick={() => notesActions()?.toggleTask()}
          />
          <NotesToolBtn
            label={<SectionIcon />}
            title="Section heading"
            active={(notesSelVersion(), notesActions()?.isActive("heading"))}
            onClick={() => notesActions()?.toggleSection()}
          />
          <NotesDivider />
          <NotesToolBtn label={<UndoIcon />} title="Undo" onClick={() => notesActions()?.undo()} />
          <NotesToolBtn label={<RedoIcon />} title="Redo" onClick={() => notesActions()?.redo()} />
          <NotesDivider />
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-icon"
            classList={{ "!text-fg !bg-bg-3": showDone(), "text-fg-subtle": !showDone() }}
            onClick={() => setShowDone(!showDone())}
            title={showDone() ? "Hide completed tasks" : "Show completed tasks"}
            data-testid="mobile-notes-show-done"
          >
            <Show when={showDone()} fallback={<EyeOffIcon />}>
              <EyeIcon />
            </Show>
            <span
              class="ml-1 rounded-sm px-1 text-[9px] font-bold"
              classList={{
                "bg-white/25 text-white": showDone(),
                "bg-bg-3 text-fg-muted": !showDone(),
              }}
            >
              {notesTaskCounts().done}
            </span>
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        <NotesPane />
      </div>
    </div>
  );
}
