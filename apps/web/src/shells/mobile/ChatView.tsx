import { Show, Suspense, createSignal, lazy } from "solid-js";
import { currentWorktreeId, ensureChatTab, state } from "@/core/stores/app";
import { createChatSession } from "@/core/chat/createChatSession";
import ChatList from "@/shells/mobile/ChatList";
import { openChatId, setOpenChatId } from "@/shells/mobile/store";

// Thread + composer pull in Tiptap, marked and DOMPurify. Behind a lazy
// boundary they cost nothing until a conversation is actually opened.
const ChatDetail = lazy(() => import("@/shells/mobile/ChatDetail"));
// Only reached from the "New chat" button.
const NewChatDialog = lazy(() => import("@/features/chat/NewChatDialog"));

/**
 * The Chats tab: a list, or one open conversation.
 *
 * A phone has no room for a tab strip, so "which chat is open" is a
 * drill-down rather than a set of tabs. It is still written through to
 * the shared store via `ensureChatTab`, which is what keeps the URL
 * (`?chat=`) correct and means opening the same link on the desktop
 * lands on the same conversation.
 */
export default function ChatView() {
  const [creating, setCreating] = createSignal(false);
  // The session is created here, above the lazy boundary, so its socket
  // and timeline survive the detail chunk loading.
  const session = createChatSession({ chatId: openChatId });

  function open(chatId: string) {
    // Mirror into the shared store so routeSync writes ?chat= and the
    // desktop shell agrees about what's focused.
    ensureChatTab(chatId);
    setOpenChatId(chatId);
  }

  const scopeName = () => {
    const p = state.projects.find((x) => x.id === state.selectedProjectId);
    if (!p) return "chat";
    const wt = currentWorktreeId();
    const branch = wt ? state.worktrees[p.id]?.find((w) => w.id === wt)?.branch : null;
    return branch ? `chat in ${branch}` : `chat in ${p.name}`;
  };

  return (
    <>
      <Show
        when={openChatId()}
        fallback={<ChatList onOpen={open} onNew={() => setCreating(true)} />}
      >
        <Suspense fallback={<ChatDetailSkeleton />}>
          <ChatDetail session={session} />
        </Suspense>
      </Show>

      <Show when={creating() && state.selectedProjectId}>
        <Suspense>
          <NewChatDialog
            projectId={state.selectedProjectId!}
            worktreeId={currentWorktreeId()}
            defaultTitle={scopeName()}
            onCancel={() => setCreating(false)}
            onCreated={(chat) => {
              setCreating(false);
              open(chat.id);
            }}
          />
        </Suspense>
      </Show>
    </>
  );
}

function ChatDetailSkeleton() {
  return (
    <div class="flex h-full flex-col justify-end gap-3 px-4 pb-4" aria-hidden="true">
      <div class="ml-auto h-10 w-2/3 rounded-2xl bg-bg-2" />
      <div class="h-4 w-5/6 rounded bg-bg-2" />
      <div class="h-4 w-3/4 rounded bg-bg-2" />
      <div class="h-11 rounded-2xl bg-bg-2" />
    </div>
  );
}
