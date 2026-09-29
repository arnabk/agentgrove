import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { Prompt } from "@/core/api/client";
import {
  assistantText,
  errorMessages,
  isPromptPending,
  thinkingText,
  toolEvents,
} from "@/core/chat/chatStream";
import { ToolRail } from "@/features/chat/ToolRail";
import Markdown from "@/ui/Markdown";

/**
 * One conversation turn: the user's message, then the assistant's.
 *
 * Full fidelity with the desktop timeline — thinking traces and the
 * tool-activity rail are both here — but collapsed behind disclosures,
 * because on a phone they would otherwise push the answer off-screen.
 * Both auto-open while the turn is in flight so the wait shows
 * progress, then collapse once it lands.
 */
export default function PromptCard(props: {
  prompt: Prompt;
  liveTokens: Record<string, string>;
  liveThinking: Record<string, string>;
  isLast: boolean;
}) {
  const answer = () => assistantText(props.prompt, props.liveTokens);
  const thinking = () => thinkingText(props.prompt, props.liveThinking);
  const tools = () => toolEvents(props.prompt);
  const errors = () => errorMessages(props.prompt);
  const pending = () =>
    isPromptPending(props.prompt, props.liveTokens, props.liveThinking, props.isLast);

  const [showThinking, setShowThinking] = createSignal(false);
  const [showTools, setShowTools] = createSignal(false);
  // Auto-collapse once the turn finishes, unless the user opened it
  // themselves after the fact.
  const [userToggled, setUserToggled] = createSignal(false);
  createEffect(() => {
    if (userToggled()) return;
    setShowThinking(pending() && thinking().length > 0);
    setShowTools(pending() && tools().length > 0);
  });

  // Elapsed counter so a long silent wait doesn't look like a hang.
  const [elapsed, setElapsed] = createSignal(0);
  createEffect(() => {
    if (!pending()) return;
    const started = Date.now();
    const handle = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    onCleanup(() => clearInterval(handle));
  });

  return (
    <article class="flex flex-col gap-2 py-3" data-testid={`mobile-prompt-${props.prompt.id}`}>
      <div class="flex justify-end">
        <div
          class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2.5 text-[14px] leading-relaxed text-fg"
          data-testid="mobile-user-message"
        >
          {props.prompt.content}
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <Show when={thinking().length > 0}>
          <Disclosure
            label={showThinking() ? "Hide thinking" : "Thinking"}
            open={showThinking()}
            onToggle={() => {
              setUserToggled(true);
              setShowThinking(!showThinking());
            }}
            testId={`mobile-thinking-toggle-${props.prompt.id}`}
          >
            <p class="whitespace-pre-wrap break-words px-1 text-[12.5px] italic leading-relaxed text-fg-muted">
              {thinking()}
            </p>
          </Disclosure>
        </Show>

        <Show when={tools().length > 0}>
          <Disclosure
            label={showTools() ? "Hide activity" : `Activity (${tools().length})`}
            open={showTools()}
            onToggle={() => {
              setUserToggled(true);
              setShowTools(!showTools());
            }}
            testId={`mobile-tools-toggle-${props.prompt.id}`}
          >
            <ToolRail events={tools()} promptId={props.prompt.id} />
          </Disclosure>
        </Show>

        <Show when={errors().length > 0}>
          <div
            class="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] leading-relaxed text-danger"
            data-testid="mobile-prompt-error"
          >
            {errors().join("\n")}
          </div>
        </Show>

        <Show when={answer().length > 0}>
          <div class="break-words" data-testid="mobile-assistant-message">
            <Markdown source={answer()} class="ag-prose-chat" />
          </div>
        </Show>

        <Show when={pending() && answer().length === 0}>
          <div
            class="flex items-center gap-2 px-1 text-[12.5px] text-fg-subtle"
            data-testid="mobile-working"
          >
            <span class="inline-flex items-end gap-0.5">
              <span
                class="h-1 w-1 animate-pulse rounded-full bg-fg-subtle"
                style={{ "animation-delay": "0ms" }}
              />
              <span
                class="h-1 w-1 animate-pulse rounded-full bg-fg-subtle"
                style={{ "animation-delay": "150ms" }}
              />
              <span
                class="h-1 w-1 animate-pulse rounded-full bg-fg-subtle"
                style={{ "animation-delay": "300ms" }}
              />
            </span>
            Working… {elapsed()}s
          </div>
        </Show>
      </div>
    </article>
  );
}

function Disclosure(props: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testId: string;
  children: import("solid-js").JSX.Element;
}) {
  return (
    <div class="rounded-lg bg-bg-2">
      <button
        type="button"
        class="flex min-h-9 w-full items-center gap-1.5 px-2.5 text-left text-[11.5px] text-fg-subtle"
        onClick={props.onToggle}
        aria-expanded={props.open}
        data-testid={props.testId}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d={props.open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} />
        </svg>
        {props.label}
      </button>
      <Show when={props.open}>
        <div class="px-1.5 pb-2">{props.children}</div>
      </Show>
    </div>
  );
}
