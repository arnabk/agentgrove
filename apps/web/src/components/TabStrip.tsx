import { For, Show, createSignal } from "solid-js";
import {
  activeTab,
  busyChats,
  closeTab,
  setActiveTab,
  renameTab,
  currentScope,
  type UnifiedTab,
  state,
} from "../stores/app";
import { api } from "../api/client";
import { confirm } from "./dialog";
import { exportChat } from "../lib/exportChat";
import { pushToast } from "./Toast";

/**
 * Unified tab strip: flat row of mixed-type tabs (chat, terminal,
 * editor). Each chip shows a type icon + label + close button.
 * The strip replaces the old pane-switcher (Chat/Editor/Terminal/
 * Notes buttons) — pane types are now just tab types.
 *
 * Double-click a tab (or use its rename affordance) to rename it.
 */

export default function TabStrip() {
  const tabs = () => currentScope()?.tabs ?? [];
  const active = () => activeTab()?.id ?? null;

  // Id of the tab currently being renamed inline, or null.
  const [editingId, setEditingId] = createSignal<string | null>(null);

  function commitRename(tabId: string, value: string) {
    renameTab(tabId, value);
    setEditingId(null);
  }

  async function close(tab: UnifiedTab) {
    if (tab.kind === "terminal") {
      const ok = await confirm({
        title: "Close terminal",
        body: "Kill this terminal session? The shell process will end.",
        confirmLabel: "Close",
        danger: true,
        testId: "confirm-close-terminal",
      });
      if (!ok) return;
    }
    closeTab(tab.id);
    if (tab.kind === "chat") {
      void api.deleteChat(tab.id).catch(() => {});
    }
  }

  async function exportTab(tab: UnifiedTab) {
    if (tab.kind !== "chat") return;
    try {
      await exportChat(tab.id, tab.title);
    } catch {
      pushToast({ title: "Export failed", message: "Could not export this chat." });
    }
  }

  function icon(kind: UnifiedTab["kind"]) {
    switch (kind) {
      case "chat":
        return (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        );
      case "terminal":
        return (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m4 9 4 3-4 3" />
            <path d="M12 15h8" />
            <rect x="2" y="4" width="20" height="16" rx="2" />
          </svg>
        );
      case "editor":
        return (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        );
    }
  }

  function label(tab: UnifiedTab): string {
    switch (tab.kind) {
      case "chat":
        return tab.title;
      case "terminal":
        return tab.label;
      case "editor":
        return tab.label;
    }
  }

  return (
    <header
      class="h-10 px-2 flex items-center gap-1 border-b border-border bg-bg-1 overflow-x-auto shrink-0"
      data-testid="tab-strip"
    >
      <For each={tabs()}>
        {(t) => (
          <div
            class="group inline-flex items-center gap-1 rounded-md border border-border bg-bg-2 pl-1.5 pr-0.5 py-0.5 text-[11.5px] cursor-pointer max-w-[200px]"
            classList={{
              "!border-accent !bg-accent-soft": t.id === active(),
              "hover:bg-bg-3": t.id !== active(),
            }}
            onClick={() => setActiveTab(t.id)}
            onDblClick={(e) => {
              e.stopPropagation();
              setEditingId(t.id);
            }}
            title={`${t.kind}: ${label(t)} — double-click to rename`}
            data-testid={`tab-${t.id}`}
          >
            <span class="text-fg-subtle shrink-0">{icon(t.kind)}</span>
            {/* Pulsing dot when this chat has an in-flight agent turn.
                Visible even when the tab isn't active so the user sees
                "something is happening" while viewing a different tab. */}
            <Show when={t.kind === "chat" && busyChats().has(t.id)}>
              <span
                class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0"
                title="Agent is working…"
                data-testid={`tab-busy-${t.id}`}
              />
            </Show>
            <Show when={editingId() === t.id} fallback={<span class="truncate">{label(t)}</span>}>
              <input
                class="bg-transparent border-b border-accent outline-none w-28 text-[11.5px]"
                value={label(t)}
                autofocus
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => commitRename(t.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(t.id, e.currentTarget.value);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingId(null);
                  }
                }}
                data-testid={`tab-rename-input-${t.id}`}
              />
            </Show>
            <Show when={t.kind === "chat"}>
              <button
                type="button"
                class="ml-0.5 px-0.5 text-fg-subtle hover:text-accent opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void exportTab(t);
                }}
                aria-label={`Export ${label(t)}`}
                title="Export chat as Markdown"
                data-testid={`tab-export-${t.id}`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M12 15V3" />
                </svg>
              </button>
            </Show>
            <button
              type="button"
              class="ml-0.5 px-0.5 text-fg-subtle hover:text-danger opacity-0 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                void close(t);
              }}
              aria-label={`Close ${label(t)}`}
              data-testid={`tab-close-${t.id}`}
            >
              ✕
            </button>
          </div>
        )}
      </For>

      <Show when={tabs().length === 0 && state.selectedProjectId}>
        <span class="text-[11px] text-fg-subtle ml-2">
          Use the left rail to open a chat, terminal, or file
        </span>
      </Show>
    </header>
  );
}
