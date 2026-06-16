import { createSignal, Show, onMount, onCleanup } from "solid-js";
import NotesPane, { notesSaving, notesSavedAt, notesErr } from "../panes/NotesPane";
import { isSidebarOpen, toggleSidebar } from "../stores/app";

/**
 * Always-visible right sidebar: the workspace-global Notes scratchpad.
 *
 * The queue used to live in the bottom half of this sidebar; it now
 * renders inline at the bottom of the chat timeline (see QueueTimeline),
 * so the sidebar is Notes-only and fills the full height.
 *
 * The sidebar is collapsible via a toggle button + resizable via a
 * drag handle on its left edge. Width persists to localStorage.
 */

const SIDEBAR_LS_KEY = "ag-sidebar-w";
const SIDEBAR_MIN_PX = 280;
const SIDEBAR_MAX_PX = 600;
const SIDEBAR_DEFAULT_PX = 340;

export default function RightSidebar() {
  // ---- Width (persisted) ----
  const persisted = Number(localStorage.getItem(SIDEBAR_LS_KEY));
  const initial =
    Number.isFinite(persisted) && persisted >= SIDEBAR_MIN_PX && persisted <= SIDEBAR_MAX_PX
      ? persisted
      : SIDEBAR_DEFAULT_PX;
  const [width, setWidth] = createSignal(initial);
  const [dragging, setDragging] = createSignal(false);

  function clamp(px: number) {
    return Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, Math.round(px)));
  }

  function onPointerDown(ev: PointerEvent) {
    ev.preventDefault();
    setDragging(true);
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  function onPointerMove(ev: PointerEvent) {
    if (!dragging()) return;
    const next = clamp(window.innerWidth - ev.clientX);
    setWidth(next);
  }
  function onPointerUp(ev: PointerEvent) {
    if (!dragging()) return;
    setDragging(false);
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(SIDEBAR_LS_KEY, String(width()));
  }
  const onWindowUp = () => {
    if (dragging()) {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(SIDEBAR_LS_KEY, String(width()));
    }
  };
  onMount(() => window.addEventListener("pointerup", onWindowUp));
  onCleanup(() => window.removeEventListener("pointerup", onWindowUp));

  // Bind mousemove globally so dragging works even if the cursor
  // leaves the tiny resize handle while the button is down.
  const onWindowMove = (ev: PointerEvent) => {
    if (dragging()) onPointerMove(ev);
  };
  onMount(() => window.addEventListener("pointermove", onWindowMove));
  onCleanup(() => window.removeEventListener("pointermove", onWindowMove));

  return (
    <Show when={isSidebarOpen()}>
      <aside
        class="relative shrink-0 h-full bg-bg-1 border-l border-border flex flex-col"
        style={{ width: `${width()}px` }}
        data-testid="right-sidebar"
      >
        {/* Resize handle on the LEFT edge */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          class="absolute top-0 left-0 h-full w-1.5 -ml-[3px] cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10 touch-none"
          classList={{ "!bg-accent/50": dragging() }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          data-testid="sidebar-resize"
        />

        {/* Notes — fills the whole sidebar now that the queue moved
            inline into the chat timeline. */}
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <header class="h-8 px-3 flex items-center gap-2 border-b border-border bg-bg-1 text-[12px] font-semibold text-fg-muted shrink-0">
            Notes
            <div class="ml-auto flex items-center gap-2 text-[11px] font-normal text-fg-subtle">
              <Show when={notesSaving()}>
                <span data-testid="notes-saving">saving…</span>
              </Show>
              <Show when={!notesSaving() && notesSavedAt()}>
                <span class="ag-chip ag-chip-success" data-testid="notes-saved-at">
                  saved {notesSavedAt()}
                </span>
              </Show>
              <Show when={notesErr()}>
                <span class="text-danger" data-testid="notes-error" title={notesErr() ?? ""}>
                  save failed
                </span>
              </Show>
            </div>
          </header>
          <div class="flex-1 min-h-0 overflow-y-auto">
            <NotesPane />
          </div>
        </div>
      </aside>
    </Show>
  );
}

/** Small toggle button the App shell renders at the edge of the
 *  main area. Shows ◀ (collapse) when open, ▶ (expand) when
 *  collapsed. */
/** Exported for callers that want the toggle in a different spot. */
export function SidebarToggle() {
  return (
    <button
      type="button"
      class="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full z-20 bg-bg-2 border border-border rounded-r-md p-1 text-fg-subtle hover:text-fg hover:bg-bg-3"
      onClick={toggleSidebar}
      title={isSidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
      aria-label={isSidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
      data-testid="sidebar-toggle-edge"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M15 3v18" />
      </svg>
    </button>
  );
}
