import { For, Show } from "solid-js";
import { unreadTeamChat } from "@/core/stores/app";
import { MOBILE_TABS, mobileTab, setMobileTab, type MobileTab } from "@/shells/mobile/store";
import { ChatIcon, NotesIcon, SettingsIcon, TeamIcon } from "@/shells/mobile/icons";

function icon(id: MobileTab) {
  switch (id) {
    case "chats":
      return <ChatIcon />;
    case "team":
      return <TeamIcon />;
    case "notes":
      return <NotesIcon />;
    case "settings":
      return <SettingsIcon />;
  }
}

/**
 * Bottom tab bar. `pb-[env(safe-area-inset-bottom)]` keeps the row
 * clear of the iOS home indicator; each target is 56px tall, above the
 * 44px accessibility minimum.
 */
export default function TabBar() {
  return (
    <nav
      class="shrink-0 border-t border-border bg-bg-1 pb-[env(safe-area-inset-bottom)]"
      data-testid="mobile-tab-bar"
    >
      <ul class="flex">
        <For each={MOBILE_TABS}>
          {(t) => {
            const active = () => mobileTab() === t.id;
            return (
              <li class="flex-1">
                <button
                  type="button"
                  class="relative flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[10px] transition-colors"
                  classList={{
                    "text-accent": active(),
                    "text-fg-subtle active:text-fg": !active(),
                  }}
                  aria-current={active() ? "page" : undefined}
                  onClick={() => setMobileTab(t.id)}
                  data-testid={`mobile-tab-${t.id}`}
                >
                  <span class="relative">
                    {icon(t.id)}
                    <Show when={t.id === "team" && unreadTeamChat() && !active()}>
                      <span
                        class="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-accent"
                        data-testid="mobile-team-unread"
                      />
                    </Show>
                  </span>
                  {t.label}
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </nav>
  );
}
