import {
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from "solid-js";
import { api } from "@/core/api/client";
import { installCrossInstanceSync } from "@/core/lib/crossInstanceSync";
import { installRouteSync } from "@/core/lib/routeSync";
import { installViewportScrollGuard } from "@/core/lib/viewportScrollGuard";
import { switchShell } from "@/core/lib/shellSelect";
import {
  bootstrap,
  clearScopeCompleted,
  currentWorktreeId,
  markScopeCompleted,
  selectedChatId,
  setLatestVersion,
  setTheme,
  setUnreadTeamChat,
  state,
} from "@/core/stores/app";
import TeamChatPane from "@/features/teamchat/TeamChatPane";
import { DialogHost } from "@/ui/dialog";
import Logo from "@/ui/Logo";
import { pushToast } from "@/ui/Toast";
import ChatView from "@/shells/mobile/ChatView";

// Each of these is a tab the user may never open on a phone, and each
// is heavy: the notes editor is Tiptap, SettingsContent is six tabs of
// forms.
const NotesView = lazy(() => import("@/shells/mobile/NotesView"));
const SettingsContent = lazy(() =>
  import("@/features/settings/SettingsModal").then((m) => ({ default: m.SettingsContent })),
);
import NavDrawer from "@/shells/mobile/NavDrawer";
import TabBar from "@/shells/mobile/TabBar";
import { BackIcon, MenuIcon, SettingsIcon } from "@/shells/mobile/icons";
import {
  drawerOpen,
  mobileTab,
  openChatId,
  setDrawerOpen,
  setOpenChatId,
  setMobileTab,
} from "@/shells/mobile/store";

/**
 * Mobile shell: a header, one full-bleed view, and a bottom tab bar.
 *
 * Covers a deliberate subset — project/worktree navigation, AI chat,
 * team chat, notes, settings. The editor, terminal, diff, database,
 * ClickUp, prompt queue, galaxy map and command palette are desktop
 * only; see ADR-0009.
 *
 * Shares the store, the route sync and the cross-instance sync channel
 * with the desktop shell, so a phone and a laptop pointed at the same
 * backend stay in step.
 */
export default function MobileApp() {
  onMount(() => {
    void bootstrap();
  });

  // URL <-> store sync, so a link opens the same scope on either shell.
  onMount(() => installRouteSync());

  // Without this the notes editor's scrollIntoView scrolls the document
  // and the header vanishes off the top of the screen.
  onMount(() => installViewportScrollGuard());

  // Live updates from every other connected client. This is what keeps
  // the phone in step with the desktop, so unlike the memory monitor it
  // is not optional on mobile.
  onMount(() => {
    const dispose = installCrossInstanceSync();
    onCleanup(dispose);
  });

  // Deliberately NOT installed here: startMemoryMonitor(). It samples
  // the heap every 15s and POSTs a trend to the backend — a debugging
  // tool for long-lived desktop sessions, and pure battery and cellular
  // data on a phone.

  createEffect(() => {
    if (state.themes.length > 0) {
      const persisted = state.settings.theme ?? localStorage.getItem("ag-theme");
      setTheme(persisted ?? state.themeId);
    }
  });

  // Looking at a scope clears its "a chat finished here" dot.
  createEffect(() => {
    const pid = state.selectedProjectId;
    if (!pid) return;
    clearScopeCompleted(pid, currentWorktreeId());
  });

  // Leaving the Team tab stops swallowing its unread badge; entering it
  // clears the badge.
  createEffect(() => {
    if (mobileTab() === "team") setUnreadTeamChat(false);
  });

  // Populate the version the Settings footer reads. Deliberately no
  // update toast: the desktop app is where you'd act on a new release,
  // and a recurring "update available" nag on a phone is just noise.
  onMount(() => {
    void api
      .version()
      .then(setLatestVersion)
      .catch(() => {
        // Offline or GitHub hiccup — the footer just shows a dash.
      });
  });

  useBackgroundChatNotifications();

  const headerTitle = () => {
    switch (mobileTab()) {
      case "team":
        return "Team chat";
      case "notes":
        return "Notes";
      case "settings":
        return "Settings";
      case "chats": {
        if (!openChatId()) return "Chats";
        const p = state.projects.find((x) => x.id === state.selectedProjectId);
        return p?.name ?? "Chat";
      }
    }
  };

  const showBack = () => mobileTab() === "chats" && openChatId() !== null;

  return (
    <>
      <Show when={state.ready} fallback={<MobileSplash />}>
        <div
          class="flex w-full flex-col overflow-hidden bg-bg"
          style={{ height: "calc(100dvh * var(--ag-zoom-inv, 1))" }}
          data-testid="mobile-app"
        >
          <header
            class="flex h-14 shrink-0 items-center gap-1 border-b border-border px-1.5 pt-[env(safe-area-inset-top)]"
            data-testid="mobile-header"
          >
            <Show
              when={showBack()}
              fallback={
                <button
                  type="button"
                  class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-11 shrink-0"
                  onClick={() => setDrawerOpen(true)}
                  aria-label="Open projects"
                  data-testid="mobile-menu"
                >
                  <MenuIcon />
                </button>
              }
            >
              <button
                type="button"
                class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-11 shrink-0"
                onClick={() => setOpenChatId(null)}
                aria-label="Back to chats"
                data-testid="mobile-back"
              >
                <BackIcon />
              </button>
            </Show>

            <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
              {headerTitle()}
            </h1>

            <Show when={mobileTab() !== "settings"}>
              <button
                type="button"
                class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-11 shrink-0"
                onClick={() => setMobileTab("settings")}
                aria-label="Open settings"
                data-testid="mobile-open-settings"
              >
                <SettingsIcon size={18} />
              </button>
            </Show>
          </header>

          <main class="min-h-0 flex-1 overflow-hidden" data-testid="mobile-main">
            <Switch>
              <Match when={mobileTab() === "chats"}>
                <ChatView />
              </Match>
              <Match when={mobileTab() === "team"}>
                <TeamChatPane />
              </Match>
              <Match when={mobileTab() === "notes"}>
                <Suspense fallback={<TabSpinner />}>
                  <NotesView />
                </Suspense>
              </Match>
              <Match when={mobileTab() === "settings"}>
                <SettingsTabBody />
              </Match>
            </Switch>
          </main>

          <TabBar />
        </div>

        <Show when={drawerOpen()}>
          <NavDrawer onClose={() => setDrawerOpen(false)} />
        </Show>
      </Show>

      <DialogHost />
    </>
  );
}

/**
 * The Settings tab. Renders the same six tabs the desktop dialog does
 * (SettingsContent is shared) full-bleed, plus the escape hatch to the
 * desktop shell — which only makes sense to offer here.
 */
function SettingsTabBody() {
  return (
    <div class="flex h-full flex-col" data-testid="mobile-settings">
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Suspense fallback={<TabSpinner />}>
          <SettingsContent />
        </Suspense>
      </div>
      <div class="shrink-0 border-t border-border px-4 py-2 text-center">
        <button
          type="button"
          class="ag-btn ag-btn-ghost ag-btn-sm text-fg-subtle"
          onClick={() => switchShell("desktop")}
          data-testid="mobile-switch-to-desktop"
        >
          Use the desktop version
        </button>
      </div>
    </div>
  );
}

/**
 * Toast + attention dot when a chat the user isn't watching finishes.
 *
 * Uses server truth (`GET /api/chats/active`) rather than a local busy
 * flag: the mobile shell only mounts one chat at a time, so a local
 * flag would read "finished" the moment the user navigated away from a
 * still-streaming turn.
 *
 * Polls at 10s rather than the desktop's 3s — the phone is usually the
 * secondary device and this runs on cellular.
 */
const ACTIVE_POLL_MS = 10_000;

function useBackgroundChatNotifications() {
  const [previous, setPrevious] = createSignal<Set<string>>(new Set());
  let scopes = new Map<string, { projectId: string; worktreeId: string | null }>();
  let firstPoll = true;

  onMount(() => {
    let stopped = false;

    async function poll() {
      try {
        const rows = await api.activeChats();
        const ids = new Set<string>();
        const next = new Map<string, { projectId: string; worktreeId: string | null }>();
        for (const r of rows) {
          ids.add(r.chat_id);
          next.set(r.chat_id, { projectId: r.project_id, worktreeId: r.worktree_id ?? null });
        }

        // Skip the first poll: chats already idle at load didn't finish
        // while the user was watching, so they shouldn't toast.
        if (!firstPoll) {
          const viewing = openChatId() ?? selectedChatId();
          for (const id of previous()) {
            if (ids.has(id) || id === viewing) continue;
            const scope = scopes.get(id);
            if (scope) markScopeCompleted(scope.projectId, scope.worktreeId);
            pushToast({
              title: "Response ready",
              message: "A chat finished in the background.",
              action: {
                label: "Go to chat",
                onClick: () => {
                  setMobileTab("chats");
                  setOpenChatId(id);
                },
              },
              timeoutMs: 8000,
            });
          }
        }
        setPrevious(ids);
        scopes = next;
        firstPoll = false;
      } catch {
        // Transient failure: keep the last known state.
      }
    }

    void poll();
    const handle = setInterval(() => {
      if (!stopped) void poll();
    }, ACTIVE_POLL_MS);
    onCleanup(() => {
      stopped = true;
      clearInterval(handle);
    });
  });
}

function TabSpinner() {
  return (
    <div class="flex h-full items-center justify-center" aria-hidden="true">
      <Logo class="ag-loader-spin h-7 w-7 opacity-60" />
    </div>
  );
}

function MobileSplash() {
  return (
    <div
      class="flex h-full w-full flex-col items-center justify-center gap-4 bg-bg"
      data-testid="mobile-splash"
    >
      <Logo class="h-12 w-12 ag-loader-spin" />
      <span class="text-[13px] text-fg-muted">Starting up…</span>
    </div>
  );
}
