import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { api, openWs } from "../api/client";
import { setUnreadTeamChat, teamChatOpen } from "../stores/app";

interface TeamChatMessage {
  id: string;
  sender: string;
  body: string;
  created_at: string;
}

export default function TeamChatPane() {
  const [messages, setMessages] = createSignal<TeamChatMessage[]>([]);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [username, setUsername] = createSignal("dev");
  let scrollRef: HTMLDivElement | undefined = undefined;
  let inputRef: HTMLInputElement | undefined = undefined;

  async function load() {
    try {
      const whoRes = await fetch(`${api.baseUrl()}/api/team-chat/whoami`);
      if (whoRes.ok) {
        const who = await whoRes.json();
        if (who.username) setUsername(who.username);
      }
      const res = await fetch(`${api.baseUrl()}/api/team-chat/messages`);
      if (res.ok) setMessages(await res.json());
      scrollToBottom();
    } catch {
      // ignore
    }
  }

  onMount(() => {
    void load();

    const ws = openWs("team-chat");
    ws.addEventListener("message", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.type === "message") {
          setMessages((m) => [...m, payload]);
          if (!teamChatOpen()) {
            setUnreadTeamChat(true);
          }
          if (
            scrollRef &&
            (scrollRef as HTMLDivElement).scrollHeight -
              (scrollRef as HTMLDivElement).scrollTop -
              (scrollRef as HTMLDivElement).clientHeight <
              100
          ) {
            scrollToBottom();
          }
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
      const sender = username();
      await fetch(`${api.baseUrl()}/api/team-chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, body: draft() }),
      });
      setDraft("");
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
    // Re-enable happens in the same Solid batch, but focus must run after
    // the DOM update removes the disabled attribute.
    queueMicrotask(() => inputRef?.focus());
  }

  return (
    <div class="flex flex-col h-full bg-bg-1 overflow-hidden w-full relative">
      <div class="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        <Show when={messages().length === 0}>
          <div class="text-[12px] text-fg-subtle text-center mt-10 italic">No messages yet</div>
        </Show>
        <For each={messages()}>
          {(m) => (
            <div class="flex flex-col gap-1">
              <div class="flex items-baseline justify-between">
                <span class="text-[11px] font-semibold text-accent">{m.sender}</span>
                <span class="text-[10px] text-fg-subtle">
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

      <div class="p-3 border-t border-border bg-bg-2 shrink-0">
        <form onSubmit={send} class="flex gap-2">
          <input
            type="text"
            ref={(el) => (inputRef = el)}
            class="ag-input flex-1 text-[13px] !py-1.5"
            placeholder="Type a message..."
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            disabled={busy()}
          />
          <button
            type="submit"
            class="ag-btn ag-btn-primary !px-3"
            disabled={busy() || !draft().trim()}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
