import { Show } from "solid-js";
import type { ChatSession } from "@/core/chat/createChatSession";
import ChatThread from "@/shells/mobile/ChatThread";
import Composer from "@/shells/mobile/Composer";

/**
 * One open conversation: thread plus composer.
 *
 * Split from ChatView purely for bundling. Everything expensive about
 * mobile chat lives below this line — Tiptap, marked and DOMPurify —
 * so keeping it behind a lazy boundary means the chat *list* paints
 * without any of it. Opening a conversation is a deliberate tap, which
 * is a fine moment to fetch a chunk.
 */
export default function ChatDetail(props: { session: ChatSession }) {
  return (
    <div class="flex h-full flex-col" data-testid="mobile-chat-view">
      <Show when={props.session.error()}>
        <div
          class="flex items-start gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12.5px] text-danger"
          data-testid="mobile-chat-error"
        >
          <span class="min-w-0 flex-1 break-words">{props.session.error()}</span>
          <button
            type="button"
            class="shrink-0 opacity-80"
            onClick={props.session.clearError}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      </Show>

      <ChatThread session={props.session} />

      <Composer
        streaming={props.session.isStreaming()}
        onSend={(body) => void props.session.send(body)}
        onStop={() => void props.session.stop()}
      />
    </div>
  );
}
