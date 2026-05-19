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
import { activePane, bootstrap, setActivePane, setState, setTheme, state } from "./stores/app";

const PANES = {
  chat: ChatPane,
  editor: EditorPane,
  diff: DiffPane,
  terminal: TerminalPane,
  queue: QueuePane,
  notes: NotesPane,
} as const;

type PaneId = keyof typeof PANES;

const PANE_META: Record<PaneId, { label: string; icon: string }> = {
  chat: { label: "Chat", icon: "💬" },
  editor: { label: "Editor", icon: "📝" },
  diff: { label: "Diff", icon: "⇄" },
  terminal: { label: "Terminal", icon: "❯_" },
  queue: { label: "Queue", icon: "≡" },
  notes: { label: "Notes", icon: "✦" },
};

export default function App() {
  onMount(async () => {
    try {
      await api.whoami();
      setState("authError", null);
      setState("authRequired", !!api.getToken());
      setState("probed", true);
      await bootstrap();
      return;
    } catch {
      // Auth required or server unreachable.
    }
    setState("probed", true);
    if (api.getToken()) {
      await bootstrap();
    } else {
      setState("ready", true);
    }
  });

  createEffect(() => {
    if (state.themes.length > 0) {
      const persisted = localStorage.getItem("ag-theme");
      setTheme(persisted ?? state.themeId);
    }
  });

  return (
    <Show when={state.probed} fallback={<LoadingScreen />}>
      <Show when={!state.authError && (api.getToken() || !state.authRequired)} fallback={<Login />}>
        <Show when={state.ready} fallback={<LoadingScreen />}>
          <div class="flex h-screen bg-bg" data-testid="app-root" data-theme="dark">
            <LeftRail />
            <main class="flex-1 flex flex-col min-w-0" data-testid="main-area">
              <nav
                class="h-11 px-3 flex items-center gap-1 border-b border-border bg-bg-1"
                data-testid="pane-tabs"
              >
                <For each={Object.keys(PANES) as PaneId[]}>
                  {(k) => (
                    <button
                      class="ag-btn ag-btn-ghost !py-1 !px-2.5 text-[12.5px]"
                      classList={{
                        "!bg-bg-3 !text-fg": activePane() === k,
                      }}
                      onClick={() => setActivePane(k)}
                      data-testid={`tab-${k}`}
                    >
                      <span aria-hidden="true" class="text-fg-subtle">
                        {PANE_META[k].icon}
                      </span>
                      <span>{PANE_META[k].label}</span>
                    </button>
                  )}
                </For>
                <div class="ml-auto flex items-center gap-2 text-[11px] text-fg-subtle">
                  <Show when={!state.authRequired}>
                    <span class="ag-chip">no auth</span>
                  </Show>
                </div>
              </nav>
              <div class="flex-1 min-h-0 bg-bg" data-testid={`pane-${activePane()}-host`}>
                <Dynamic component={PANES[activePane()]} />
              </div>
              <StatusBar />
            </main>
          </div>
        </Show>
      </Show>
    </Show>
  );
}

function LoadingScreen() {
  return (
    <div class="min-h-screen flex items-center justify-center bg-bg">
      <div class="flex items-center gap-2 text-fg-muted text-sm">
        <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
        Loading…
      </div>
    </div>
  );
}

function StatusBar() {
  const projectName = () => state.projects.find((p) => p.id === state.selectedProjectId)?.name;
  const worktreeName = () => {
    const pid = state.selectedProjectId;
    if (!pid) return undefined;
    return state.worktrees[pid]?.find((w) => w.id === state.selectedWorktreeId)?.branch;
  };
  const chatTitle = () => {
    const wid = state.selectedWorktreeId;
    if (!wid) return undefined;
    return state.chats[wid]?.find((c) => c.id === state.selectedChatId)?.title;
  };
  return (
    <div
      class="h-7 px-3 flex items-center gap-3 text-[11px] text-fg-subtle border-t border-border bg-bg-1"
      data-testid="status-bar"
    >
      <span class="flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-success" /> connected
      </span>
      <Show when={projectName()}>
        <span>·</span>
        <span class="font-mono">{projectName()}</span>
      </Show>
      <Show when={worktreeName()}>
        <span>·</span>
        <span class="font-mono">⎇ {worktreeName()}</span>
      </Show>
      <Show when={chatTitle()}>
        <span>·</span>
        <span>◇ {chatTitle()}</span>
      </Show>
    </div>
  );
}
