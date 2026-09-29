import { For, Show, createEffect, onMount } from "solid-js";
import type { ChatSession } from "@/core/chat/createChatSession";
import PromptCard from "@/shells/mobile/PromptCard";

/**
 * Scrolling turn list.
 *
 * Deliberately not virtualized. The desktop timeline is (ADR-0006) and
 * has to be: it renders hundreds of turns in a tall window on a machine
 * also hosting xterm and CodeMirror. Here the window holds three or
 * four turns, and the store is already capped at MAX_PROMPTS_IN_VIEW,
 * so a windowed renderer would add measurement cost and scroll-anchoring
 * bugs to buy nothing. If phone chats ever get long enough to matter,
 * the fix is paging, not virtualization.
 *
 * Scroll behaviour: stick to the bottom while the user is already
 * there, and leave them alone once they have scrolled up to read.
 */
const BOTTOM_THRESHOLD_PX = 80;

export default function ChatThread(props: { session: ChatSession }) {
  let scroller: HTMLDivElement | undefined;
  let stickToBottom = true;

  const atBottom = () => {
    if (!scroller) return true;
    return (
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_THRESHOLD_PX
    );
  };

  function toBottom(behavior: ScrollBehavior = "auto") {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
  }

  onMount(() => queueMicrotask(() => toBottom()));

  // Re-pin on every store change that grows the thread, but only while
  // the user hasn't scrolled away.
  createEffect(() => {
    const last = props.session.store.prompts[props.session.store.prompts.length - 1];
    // Track the streaming text so the pin follows tokens as they land.
    void (last ? props.session.store.liveTokens[last.id] : undefined);
    void props.session.store.prompts.length;
    if (!stickToBottom) return;
    queueMicrotask(() => toBottom());
  });

  function onScroll() {
    if (!scroller) return;
    stickToBottom = atBottom();
    // Reaching the top asks for the previous page.
    if (scroller.scrollTop <= 0) void props.session.loadOlder();
  }

  return (
    <div
      ref={(el) => (scroller = el)}
      class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4"
      onScroll={onScroll}
      data-testid="mobile-chat-thread"
    >
      {/* `mt-auto` pins a short conversation to the bottom of the
          viewport, next to the composer, instead of stranding it at the
          top under a screen of empty space. Once the content overflows,
          auto margins collapse and normal scrolling takes over. */}
      <div class="mt-auto">
        <Show when={!props.session.store.atStart && props.session.store.prompts.length > 0}>
          <p class="py-2 text-center text-[11.5px] text-fg-subtle">
            <Show when={props.session.store.loadingOlder} fallback="Scroll up for older messages">
              Loading older…
            </Show>
          </p>
        </Show>

        <Show
          when={props.session.store.prompts.length > 0}
          fallback={
            <p class="px-2 py-12 text-center text-[13px] leading-relaxed text-fg-subtle">
              Send a message to get started.
            </p>
          }
        >
          <For each={props.session.store.prompts}>
            {(p, i) => (
              <PromptCard
                prompt={p}
                liveTokens={props.session.store.liveTokens}
                liveThinking={props.session.store.liveThinking}
                isLast={i() === props.session.store.prompts.length - 1}
              />
            )}
          </For>
        </Show>
        {/* Breathing room so the last bubble clears the composer. */}
        <div class="h-3" aria-hidden="true" />
      </div>
    </div>
  );
}
