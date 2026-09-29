import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { api, openWs, type TeamChatMessage } from "@/core/api/client";
import { setUnreadTeamChat, teamChatOpen } from "@/core/stores/app";

/** How close to the bottom counts as "following the conversation". */
const BOTTOM_THRESHOLD_PX = 100;

export default function TeamChatPane() {
  const [messages, setMessages] = createSignal<TeamChatMessage[]>([]);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [username, setUsername] = createSignal("dev");
  let scrollRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  async function load() {
    // Identity first: prefers the authenticated email over the server's
    // OS user, so several devices don't all post as the same name.
    setUsername(await api.teamChatIdentity());
    try {
      setMessages(await api.teamChatMessages());
      scrollToBottom();
    } catch {
      // Leave the pane empty; the WS will still deliver new messages.
    }
  }

  onMount(() => {
    void load();

    const ws = openWs("team-chat");
    ws.addEventListener("message", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.type !== "message") return;
        setMessages((m) => [...m, payload]);
        if (!teamChatOpen()) setUnreadTeamChat(true);
        const el = scrollRef;
        if (el && el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX) {
          scrollToBottom();
        }
      } catch {
        // ignore
      }
    });
    onCleanup(() => ws.close());
  });

  function scrollToBottom() {
    setTimeout(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
    }, 50);
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    if (!draft().trim() || busy()) return;
    setBusy(true);
    try {
      await api.teamChatSend(username(), draft());
      setDraft("");
    } catch {
      // Keep the draft so the user can retry.
    } finally {
      setBusy(false);
    }
    // Re-enable happens in the same Solid batch, but focus must run after
    // the DOM update removes the disabled attribute.
    queueMicrotask(() => inputRef?.focus());
  }

  return (
    <div class="flex flex-col h-full bg-bg-1 overflow-hidden w-full relative">
      <div
        class="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4"
        ref={(el) => (scrollRef = el)}
      >
        <Show when={messages().length === 0}>
          <div class="text-[12px] text-fg-subtle text-center mt-10 italic">No messages yet</div>
        </Show>
        <For each={messages()}>
          {(m) => (
            <div class="flex flex-col gap-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-[11px] font-semibold text-accent truncate">{m.sender}</span>
                <span class="text-[10px] text-fg-subtle shrink-0">
                  {new Date(m.created_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <div class="text-[13px] text-fg leading-snug break-words whitespace-pre-wrap">
                {m.body}
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="p-3 border-t border-border bg-bg-2 shrink-0 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <form onSubmit={send} class="flex gap-2">
          <input
            type="text"
            ref={(el) => (inputRef = el)}
            class="ag-input flex-1 text-[13px] !py-2 min-w-0"
            placeholder="Type a message..."
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            disabled={busy()}
            data-testid="team-chat-input"
          />
          <button
            type="submit"
            class="ag-btn ag-btn-primary !px-3 shrink-0"
            disabled={busy() || !draft().trim()}
            data-testid="team-chat-send"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
