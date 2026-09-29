import { For, Show, createEffect, createSignal } from "solid-js";
import { api, type Chat } from "@/core/api/client";
import { currentWorktreeId, isScopeWorking, state } from "@/core/stores/app";
import { useSyncSubscription } from "@/core/lib/crossInstanceSync";
import { confirm } from "@/ui/dialog";
import { pushToast } from "@/ui/Toast";
import { ChatIcon, PlusIcon, TrashIcon } from "@/shells/mobile/icons";

/**
 * Chats in the active scope, newest first.
 *
 * Reads straight from `GET /api/projects/:id/chats` rather than from
 * the scope's tab list: the desktop tab strip is a working set the user
 * curates, but on a phone the expectation is simply "all my chats
 * here". Subscribes to the cross-instance sync channel so a chat
 * started on the desktop appears without a pull-to-refresh.
 */
export default function ChatList(props: { onOpen: (chatId: string) => void; onNew: () => void }) {
  const [chats, setChats] = createSignal<Chat[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  async function load() {
    const pid = state.selectedProjectId;
    if (!pid) {
      setChats([]);
      setLoading(false);
      return;
    }
    const wt = currentWorktreeId();
    try {
      const all = await api.listProjectChats(pid);
      // Guard against a scope switch landing while this was in flight.
      if (state.selectedProjectId !== pid || currentWorktreeId() !== wt) return;
      setChats(
        all
          .filter((c) => (c.worktree_id ?? null) === wt)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    void state.selectedProjectId;
    void currentWorktreeId();
    setLoading(true);
    void load();
  });

  useSyncSubscription((frame) => {
    if (frame.kind !== "chat_created" && frame.kind !== "chat_updated") return;
    if (frame.project_id !== state.selectedProjectId) return;
    if ((frame.worktree_id ?? null) !== currentWorktreeId()) return;
    void load();
  });

  async function remove(c: Chat) {
    const ok = await confirm({
      title: "Delete chat",
      body: `Delete "${c.title}"? Its history is removed.`,
      confirmLabel: "Delete",
      danger: true,
      testId: "confirm-delete-chat-mobile",
    });
    if (!ok) return;
    try {
      await api.deleteChat(c.id);
      await load();
    } catch (e) {
      pushToast({
        title: "Could not delete chat",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const scopeLabel = () => {
    const p = state.projects.find((x) => x.id === state.selectedProjectId);
    if (!p) return null;
    const wt = currentWorktreeId();
    const branch = wt ? state.worktrees[p.id]?.find((w) => w.id === wt)?.branch : null;
    return branch ? `${p.name} · ${branch}` : p.name;
  };

  return (
    <div class="flex h-full flex-col" data-testid="mobile-chat-list">
      <Show
        when={state.selectedProjectId}
        fallback={
          <p class="px-6 py-10 text-center text-[13px] leading-relaxed text-fg-subtle">
            Pick a project from the menu to see its chats.
          </p>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Show when={scopeLabel()}>
            <p class="px-4 pb-1 pt-3 text-[11px] uppercase tracking-wider text-fg-subtle">
              {scopeLabel()}
            </p>
          </Show>

          <Show when={error()}>
            <p class="px-4 py-2 text-[12.5px] text-danger" data-testid="mobile-chat-list-error">
              {error()}
            </p>
          </Show>

          <Show when={!loading()} fallback={<ListSkeleton />}>
            <Show
              when={chats().length > 0}
              fallback={
                <p class="px-6 py-10 text-center text-[13px] leading-relaxed text-fg-subtle">
                  No chats here yet.
                </p>
              }
            >
              <ul class="divide-y divide-border">
                <For each={chats()}>
                  {(c) => (
                    <li class="flex items-center">
                      <button
                        type="button"
                        class="flex min-h-[60px] flex-1 items-center gap-3 px-4 text-left active:bg-bg-2"
                        onClick={() => props.onOpen(c.id)}
                        data-testid={`mobile-chat-${c.id}`}
                      >
                        <span class="shrink-0 text-fg-subtle">
                          <ChatIcon size={18} />
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-[14px] font-medium">{c.title}</span>
                          <span class="block truncate text-[11.5px] text-fg-subtle">
                            {c.provider} · {c.model}
                          </span>
                        </span>
                        <Show
                          when={isScopeWorking(c.project_id, c.worktree_id ?? null)}
                          fallback={null}
                        >
                          <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
                        </Show>
                      </button>
                      <button
                        type="button"
                        class="ag-btn ag-btn-ghost ag-btn-icon !h-[60px] !w-11 shrink-0 text-fg-subtle"
                        onClick={() => void remove(c)}
                        aria-label={`Delete ${c.title}`}
                        data-testid={`mobile-delete-chat-${c.id}`}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>

        <div class="shrink-0 border-t border-border p-3">
          <button
            type="button"
            class="ag-btn ag-btn-primary flex min-h-11 w-full items-center justify-center gap-2 text-[14px]"
            onClick={props.onNew}
            data-testid="mobile-new-chat"
          >
            <PlusIcon size={17} />
            New chat
          </button>
        </div>
      </Show>
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul class="divide-y divide-border" aria-hidden="true">
      <For each={[0, 1, 2]}>
        {() => (
          <li class="flex min-h-[60px] items-center gap-3 px-4">
            <span class="h-4 w-4 shrink-0 rounded bg-bg-3" />
            <span class="flex-1 space-y-1.5">
              <span class="block h-3 w-1/2 rounded bg-bg-3" />
              <span class="block h-2.5 w-1/4 rounded bg-bg-2" />
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}
