import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import ChangesPanel from "./components/ChangesPanel";
import CommandPalette from "./components/CommandPalette";
import { DialogHost } from "./components/dialog";
import LeftRail from "./components/LeftRail";
import MemoryIndicator from "./components/MemoryIndicator";
import SettingsModal from "./components/SettingsModal";
import Welcome from "./components/Welcome";
import { installRouteSync } from "./lib/routeSync";
import { installCrossInstanceSync } from "./lib/crossInstanceSync";
import { declareMemorySource, estimateJsonBytes, recordMemoryUsage } from "./lib/memory";

declareMemorySource("rail.projects", "Project + worktree state");
import ChatPane from "./panes/ChatPane";
import EditorPane from "./panes/EditorPane";
import TerminalPane from "./panes/TerminalPane";
import NotesPane from "./panes/NotesPane";
import {
  activePane,
  bootstrap,
  changesScope,
  setActivePane,
  setSettingsOpen,
  setTheme,
  state,
} from "./stores/app";

const PANES = {
  chat: ChatPane,
  editor: EditorPane,
  terminal: TerminalPane,
  notes: NotesPane,
} as const;

type PaneId = keyof typeof PANES;

const PANE_META: Record<PaneId, { label: string; Icon: () => JSX.Element }> = {
  chat: { label: "Chat", Icon: ChatIcon },
  editor: { label: "Editor", Icon: EditorIcon },
  terminal: { label: "Terminal", Icon: TerminalIcon },
  notes: { label: "Notes", Icon: NotesIcon },
};

export default function App() {
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
        <div class="h-screen p-4 sm:p-5 md:p-6 flex" data-testid="app-root" data-theme="dark">
          <div class="ag-shell flex-1 flex min-w-0 rounded-xl border border-border shadow-2xl overflow-hidden">
            <Show when={state.projects.length > 0} fallback={null}>
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
                <nav
                  class="h-12 px-4 flex items-center gap-1.5 border-b border-border bg-transparent"
                  data-testid="pane-tabs"
                >
                  <For each={Object.keys(PANES) as PaneId[]}>
                    {(k) => (
                      <button
                        class="ag-btn ag-btn-ghost !py-1.5 !px-3 text-[12.5px]"
                        classList={{
                          "!bg-bg-3 !text-fg": activePane() === k,
                        }}
                        onClick={() => setActivePane(k)}
                        data-testid={`tab-${k}`}
                      >
                        <span aria-hidden="true" class="text-fg-subtle inline-flex items-center">
                          {PANE_META[k].Icon()}
                        </span>
                        <span>{PANE_META[k].label}</span>
                      </button>
                    )}
                  </For>
                  <div class="ml-auto flex items-center gap-2">
                    <SettingsButton />
                    <TopBarIndicators />
                  </div>
                </nav>
                <div
                  class="flex-1 min-h-0 bg-transparent p-5"
                  data-testid={`pane-${activePane()}-host`}
                >
                  {/*
                  All panes stay MOUNTED simultaneously and we toggle
                  visibility via CSS. Unmounting on tab switch tore
                  down each pane's local state — the chat composer
                  draft, scroll position, file-tree expansion, etc.
                  — which made simple "flip to terminal, come back"
                  flows lose work the user didn't realise was
                  in-flight. Keeping all panes mounted matches the
                  TerminalPane's own internal tab strategy (hide
                  via display:none) and trades a small memory cost
                  for predictable persistence.
                */}
                  <div class="ag-pane h-full rounded-lg border border-border overflow-hidden relative">
                    <For each={Object.keys(PANES) as PaneId[]}>
                      {(k) => (
                        <div
                          class="absolute inset-0"
                          style={{ display: activePane() === k ? "block" : "none" }}
                          data-testid={`pane-mount-${k}`}
                        >
                          <Dynamic component={PANES[k]} />
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </main>
          </div>
        </div>
      </Show>
      <SettingsModal />
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
function ChatIcon() {
  return (
    <svg
      width="15"
      height="15"
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
}

/** Lucide `file-code-2` — used for the Editor pane tab. */
function EditorIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="m5 12-3 3 3 3" />
      <path d="m9 18 3-3-3-3" />
    </svg>
  );
}

/** Lucide `terminal-square` — used for the Terminal pane tab. */
function TerminalIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  );
}

/** Lucide `notebook-pen` — used for the Notes pane tab. */
function NotesIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.6" />
      <path d="M2 6h4" />
      <path d="M2 10h4" />
      <path d="M2 14h4" />
      <path d="M2 18h4" />
      <path d="M21.4 4.6a2.1 2.1 0 1 1 3 3L16 16l-4 1 1-4z" />
    </svg>
  );
}

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
