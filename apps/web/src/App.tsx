import { For, Show, createEffect, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import { api } from "./api/client";
import Login from "./components/Login";
import LeftRail from "./components/LeftRail";
import ChatPane from "./panes/ChatPane";
import EditorPane from "./panes/EditorPane";
import DiffPane from "./panes/DiffPane";
import TerminalPane from "./panes/TerminalPane";
import QueuePane from "./panes/QueuePane";
import NotesPane from "./panes/NotesPane";
import { activePane, bootstrap, setActivePane, setTheme, state } from "./stores/app";

const PANES = {
  chat: ChatPane,
  editor: EditorPane,
  diff: DiffPane,
  terminal: TerminalPane,
  queue: QueuePane,
  notes: NotesPane,
};

const PANE_LABELS: Record<keyof typeof PANES, string> = {
  chat: "Chat",
  editor: "Editor",
  diff: "Diff",
  terminal: "Terminal",
  queue: "Queue",
  notes: "Notes",
};

export default function App() {
  onMount(async () => {
    const persisted = localStorage.getItem("ag-theme");
    if (persisted) {
      // Theme is applied after themes load via createEffect below.
    }
    if (api.getToken()) {
      await bootstrap();
    }
  });

  createEffect(() => {
    if (state.themes.length > 0) {
      const persisted = localStorage.getItem("ag-theme");
      setTheme(persisted ?? state.themeId);
    }
  });

  return (
    <Show when={api.getToken() && !state.authError} fallback={<Login />}>
      <Show when={state.ready} fallback={<div class="p-8">Loading…</div>}>
        <div class="flex h-screen" data-testid="app-root" data-theme="dark">
          <LeftRail />
          <main class="flex-1 flex flex-col min-w-0" data-testid="main-area">
            <nav class="flex border-b border-[var(--ag-muted)]" data-testid="pane-tabs">
              <For each={Object.keys(PANES) as Array<keyof typeof PANES>}>
                {(k) => (
                  <button
                    class="px-4 py-2 text-sm border-r border-[var(--ag-muted)]"
                    classList={{
                      "bg-[var(--ag-accent)]/30": activePane() === k,
                    }}
                    onClick={() => setActivePane(k)}
                    data-testid={`tab-${k}`}
                  >
                    {PANE_LABELS[k]}
                  </button>
                )}
              </For>
            </nav>
            <div class="flex-1 min-h-0" data-testid={`pane-${activePane()}-host`}>
              <Dynamic component={PANES[activePane()]} />
            </div>
          </main>
        </div>
      </Show>
    </Show>
  );
}
