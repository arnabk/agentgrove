import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import ChangesPanel from "./components/ChangesPanel";
import CommandPalette from "./components/CommandPalette";
import { DialogHost } from "./components/dialog";
import LeftRail from "./components/LeftRail";
import MemoryIndicator from "./components/MemoryIndicator";
import RightSidebar from "./components/RightSidebar";
import SettingsModal from "./components/SettingsModal";
import TabStrip from "./components/TabStrip";
import NewChatDialog from "./components/NewChatDialog";
import Welcome from "./components/Welcome";
import { installRouteSync } from "./lib/routeSync";
import { installCrossInstanceSync } from "./lib/crossInstanceSync";
import { declareMemorySource, estimateJsonBytes, recordMemoryUsage } from "./lib/memory";

declareMemorySource("rail.projects", "Project + worktree state");
import ChatPane from "./panes/ChatPane";
import EditorPane from "./panes/EditorPane";
import TerminalPane from "./panes/TerminalPane";
import {
  activeTab,
  addChatTab,
  addTerminalTab,
  bootstrap,
  changesScope,
  currentScope,
  isSidebarOpen,
  setSettingsOpen,
  setTheme,
  state,
  toggleSidebar,
} from "./stores/app";
import { api } from "./api/client";

export default function App() {
  // NewChatDialog state — reused from LeftRail's pattern.
  const [newChatFor, setNewChatFor] = createSignal<{
    projectId: string;
    worktreeId: string | null;
    parentName: string;
  } | null>(null);

  // Left rail collapse state (persisted to localStorage).
  const [leftRailOpen, setLeftRailOpen] = createSignal(
    localStorage.getItem("ag-left-rail-open") !== "0",
  );
  function toggleLeftRail() {
    const next = !leftRailOpen();
    setLeftRailOpen(next);
    localStorage.setItem("ag-left-rail-open", next ? "1" : "0");
  }

  function openNewChatDialog() {
    const pid = state.selectedProjectId;
    if (!pid) return;
    const p = state.projects.find((x) => x.id === pid);
    if (!p) return;
    const wid = state.selectedWorktreeByProject[pid] ?? null;
    setNewChatFor({
      projectId: pid,
      worktreeId: wid,
      parentName: p.name,
    });
  }

  async function openNewTerminal() {
    const pid = state.selectedProjectId;
    if (!pid) return;
    try {
      const t = await api.createTerminal({
        cols: 80,
        rows: 24,
        project_id: pid,
        ...(state.selectedWorktreeByProject[pid]
          ? { worktree_id: state.selectedWorktreeByProject[pid]! }
          : {}),
      });
      const scope = currentScope();
      const termCount = scope?.tabs.filter((x) => x.kind === "terminal").length ?? 0;
      addTerminalTab({
        id: t.id,
        cwd: t.cwd,
        label: `term ${termCount + 1}`,
      });
    } catch {
      // silently fail — user can retry
    }
  }
  onMount(async () => {
    await bootstrap();
  });

  // Bidirectional sync between the URL and the active workspace
  // state. Refreshing keeps you on the same scope + pane + chat +
  // file; copy-pasting the URL into another tab opens the same view.
  installRouteSync();

  // Cross-browser-instance sync: open one WS to `/ws?topic=sync`
  // and react to project / worktree / chat / scratchpad changes
  // any other connected client makes. This is what lets two
  // different browsers (or two machines) stay in step — same-
  // origin BroadcastChannel covers only same-instance tabs.
  onMount(() => {
    const dispose = installCrossInstanceSync();
    onCleanup(dispose);
  });

  createEffect(() => {
    if (state.themes.length > 0) {
      const persisted = state.settings.theme ?? localStorage.getItem("ag-theme");
      setTheme(persisted ?? state.themeId);
    }
  });

  // Report the project + worktree registry to the memory accountant.
  // These structures are small (kilobytes), but they're entirely
  // ours and worth attributing.
  createEffect(() => {
    let bytes = 0;
    bytes += estimateJsonBytes(state.projects);
    bytes += estimateJsonBytes(state.worktrees);
    bytes += estimateJsonBytes(state.byScope);
    recordMemoryUsage("rail.projects", bytes);
  });

  // Cmd+P palette state. The palette OWNS its own internal keys
  // (arrows / Enter / Esc); we only handle the open keystroke here
  // so the global binding works regardless of which pane has focus.
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  // Global keybindings:
  //   ⌘/Ctrl + ,  → Settings
  //   ⌘/Ctrl + P  → Cmd+P fuzzy file finder (VSCode-style)
  function onKey(e: KeyboardEvent) {
    if (e.key === "," && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSettingsOpen(true);
      return;
    }
    if ((e.key === "p" || e.key === "P") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      // Browser's default Cmd+P (Print) is the wrong instinct for a
      // dev tool; we hijack it. Shift+Cmd+P stays available for the
      // browser's standard print + the user can still hit File →
      // Print from the menu bar if they need it.
      e.preventDefault();
      setPaletteOpen(true);
    }
  }
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <>
      <Show when={state.ready} fallback={<LoadingScreen />}>
        <div class="h-screen flex" data-testid="app-root" data-theme="dark">
          <div class="ag-shell flex-1 flex min-w-0 overflow-hidden">
            <Show when={state.projects.length > 0 && leftRailOpen()} fallback={null}>
              <LeftRail />
            </Show>
            <main class="flex-1 flex flex-col min-w-0 bg-transparent" data-testid="main-area">
              <Show
                when={state.projects.length > 0}
                fallback={
                  <>
                    <header
                      class="h-12 px-4 flex items-center justify-end gap-2 border-b border-border bg-transparent"
                      data-testid="top-bar"
                    >
                      <SettingsButton />
                      <TopBarIndicators />
                    </header>
                    <div class="flex-1 min-h-0 bg-transparent">
                      <Welcome />
                    </div>
                  </>
                }
              >
                {/* Top bar: unified tab strip + settings + indicators */}
                <div class="flex items-center border-b border-border bg-bg-1 shrink-0">
                  {/* Left rail toggle */}
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost ag-btn-icon shrink-0 ml-1"
                    onClick={toggleLeftRail}
                    title={leftRailOpen() ? "Hide projects" : "Show projects"}
                    data-testid="left-rail-toggle"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M9 3v18" />
                    </svg>
                  </button>
                  <div class="flex-1 min-w-0 overflow-hidden">
                    <TabStrip
                      onNewChat={() => openNewChatDialog()}
                      onNewTerminal={() => openNewTerminal()}
                      onOpenFile={() => setPaletteOpen(true)}
                    />
                  </div>
                  <div class="flex items-center gap-2 px-3 shrink-0">
                    <button
                      type="button"
                      class="ag-btn ag-btn-ghost ag-btn-icon"
                      onClick={toggleSidebar}
                      title={isSidebarOpen() ? "Hide sidebar" : "Show sidebar"}
                      data-testid="sidebar-toggle"
                    >
                      <svg
                        width="16"
                        height="16"
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
                    <SettingsButton />
                    <TopBarIndicators />
                  </div>
                </div>

                {/* Main content: active tab pane + right sidebar */}
                <div class="flex-1 flex min-h-0">
                  <div class="flex-1 min-w-0 relative">
                    {/* Render the active tab's content. Each tab type
                        gets its own host div keyed by tab.id so xterm /
                        Tiptap / CodeMirror instances survive tab
                        switches (display:none/block toggle). */}
                    <For each={currentScope()?.tabs ?? []}>
                      {(tab) => (
                        <div
                          class="absolute inset-0"
                          style={{
                            display: tab.id === (activeTab()?.id ?? null) ? "block" : "none",
                          }}
                          data-testid={`tab-host-${tab.id}`}
                        >
                          <Show when={tab.kind === "chat"}>
                            <ChatPane />
                          </Show>
                          <Show when={tab.kind === "terminal"}>
                            <TerminalPane />
                          </Show>
                          <Show when={tab.kind === "editor"}>
                            <EditorPane />
                          </Show>
                        </div>
                      )}
                    </For>
                    <Show when={(currentScope()?.tabs ?? []).length === 0}>
                      <div class="absolute inset-0 flex items-center justify-center text-[13px] text-fg-subtle px-6 text-center">
                        Click <span class="ag-kbd mx-1">+</span> in the tab strip or use the left
                        rail to open a chat, terminal, or file.
                      </div>
                    </Show>
                  </div>
                  <RightSidebar />
                </div>
              </Show>
            </main>
          </div>
        </div>
      </Show>
      <SettingsModal />
      <Show when={newChatFor()} keyed>
        {(ctx) => (
          <NewChatDialog
            projectId={ctx.projectId}
            worktreeId={ctx.worktreeId}
            defaultTitle={`chat in ${ctx.parentName}`}
            onCancel={() => setNewChatFor(null)}
            onCreated={(chat) => {
              addChatTab({ id: chat.id, title: chat.title });
              setNewChatFor(null);
            }}
          />
        )}
      </Show>
      <Show when={changesScope()}>
        <ChangesPanel />
      </Show>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <DialogHost />
    </>
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

/** Top-right indicators: connection + memory usage. */
function TopBarIndicators() {
  return (
    <div class="flex items-center gap-2 text-[11px] text-fg-subtle" data-testid="top-indicators">
      <MemoryIndicator />
      <span
        class="inline-flex items-center gap-1.5 ag-chip"
        title="Connected to backend"
        data-testid="indicator-connected"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-success" />
        connected
      </span>
    </div>
  );
}

/** Gear icon that opens the Settings modal. */
function SettingsButton() {
  return (
    <button
      class="ag-btn ag-btn-ghost ag-btn-icon"
      onClick={() => setSettingsOpen(true)}
      title="Settings  ⌘,"
      aria-label="Open settings"
      data-testid="open-settings"
    >
      <GearIcon />
    </button>
  );
}

/** Lucide `message-square` — used for the Chat pane tab. */
function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
    </svg>
  );
}
