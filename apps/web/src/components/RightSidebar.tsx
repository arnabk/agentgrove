import { createSignal, Show, onMount, onCleanup } from "solid-js";
import NotesPane from "../panes/NotesPane";
import QueueDrawer from "./QueueDrawer";
import { isSidebarOpen, toggleSidebar, selectedChatId } from "../stores/app";

/**
 * Always-visible right sidebar: Notes (top) + Queue (bottom).
 *
 * Notes is the per-project Tiptap scratchpad (unchanged from the
 * old NotesPane — we just host it here instead of in a pane tab).
 * Queue shows the prompt queue for the currently-active chat tab
 * (if any); when no chat is active the queue section collapses.
 *
 * The sidebar is collapsible via a toggle button + resizable
 * via a drag handle on its left edge. Width persists to
 * localStorage.
 */

const SIDEBAR_LS_KEY = "ag-sidebar-w";
const SIDEBAR_MIN_PX = 280;
const SIDEBAR_MAX_PX = 600;
const SIDEBAR_DEFAULT_PX = 340;

const DIVIDER_LS_KEY = "ag-sidebar-divider";
const DIVIDER_DEFAULT_PCT = 60; // notes gets 60% by default

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
    if (divDragging()) {
      setDivDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(DIVIDER_LS_KEY, String(notesPct()));
    }
  };
  onMount(() => window.addEventListener("pointerup", onWindowUp));
  onCleanup(() => window.removeEventListener("pointerup", onWindowUp));

  // ---- Divider (Notes / Queue split, persisted) ----
  const persistedDiv = Number(localStorage.getItem(DIVIDER_LS_KEY));
  const initialDiv =
    Number.isFinite(persistedDiv) && persistedDiv >= 20 && persistedDiv <= 80
      ? persistedDiv
      : DIVIDER_DEFAULT_PCT;
  const [notesPct, setNotesPct] = createSignal(initialDiv);
  const [divDragging, setDivDragging] = createSignal(false);
  let sidebarRef: HTMLElement | undefined;

  function onDivDown(ev: PointerEvent) {
    ev.preventDefault();
    setDivDragging(true);
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }
  function onDivMove(ev: PointerEvent) {
    if (!divDragging() || !sidebarRef) return;
    const rect = sidebarRef.getBoundingClientRect();
    const pct = Math.min(80, Math.max(20, ((ev.clientY - rect.top) / rect.height) * 100));
    setNotesPct(Math.round(pct));
  }
  function onDivUp(ev: PointerEvent) {
    if (!divDragging()) return;
    setDivDragging(false);
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(DIVIDER_LS_KEY, String(notesPct()));
  }

  // Bind mousemove globally so dragging works even if the cursor
  // leaves the tiny 6px handle while the button is down.
  const onWindowMove = (ev: PointerEvent) => {
    if (dragging()) onPointerMove(ev);
    if (divDragging()) onDivMove(ev);
  };
  onMount(() => window.addEventListener("pointermove", onWindowMove));
  onCleanup(() => window.removeEventListener("pointermove", onWindowMove));

  const chatId = () => selectedChatId();

  return (
    <Show when={isSidebarOpen()}>
      <aside
        ref={(el) => (sidebarRef = el)}
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

        {/* Notes section (top) */}
        <div class="overflow-hidden flex flex-col" style={{ height: `${notesPct()}%` }}>
          <header class="h-8 px-3 flex items-center border-b border-border bg-bg-1 text-[12px] font-semibold text-fg-muted shrink-0">
            Notes
          </header>
          <div class="flex-1 min-h-0 overflow-y-auto">
            <NotesPane />
          </div>
        </div>

        {/* Horizontal divider handle */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize notes / queue split"
          class="h-1.5 cursor-row-resize hover:bg-accent/30 active:bg-accent/50 transition-colors touch-none shrink-0"
          classList={{ "!bg-accent/50": divDragging() }}
          onPointerDown={onDivDown}
          onPointerUp={onDivUp}
          data-testid="sidebar-divider"
        />

        {/* Queue section (bottom) */}
        <div class="overflow-hidden flex flex-col" style={{ height: `${100 - notesPct()}%` }}>
          <Show
            when={chatId()}
            fallback={
              <div class="flex-1 flex items-center justify-center text-[12px] text-fg-subtle px-3 text-center">
                Select a chat to see its queue
              </div>
            }
          >
            <QueueDrawer chatId={chatId()!} open={true} onClose={() => {}} />
          </Show>
        </div>
      </aside>
    </Show>
  );
}

/** Small toggle button the App shell renders at the edge of the
 *  main area. Shows ◀ (collapse) when open, ▶ (expand) when
 *  collapsed. */
export function SidebarToggle() {
  return (
    <button
      type="button"
      class="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full z-20 bg-bg-2 border border-border rounded-r-md px-0.5 py-2 text-[10px] text-fg-subtle hover:text-fg hover:bg-bg-3"
      onClick={toggleSidebar}
      title={isSidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
      aria-label={isSidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
      data-testid="sidebar-toggle"
    >
      {isSidebarOpen() ? "◀" : "▶"}
    </button>
  );
}
