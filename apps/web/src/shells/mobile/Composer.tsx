import { For, Show, createSignal } from "solid-js";
import { api, type UploadDto } from "@/core/api/client";
import ChatComposer, { type ChatComposerHandle } from "@/ui/ChatComposer";
import MicButton from "@/ui/MicButton";
import { PlusIcon, SendIcon, StopIcon } from "@/shells/mobile/icons";

/**
 * Message composer. Wraps the same Tiptap editor the desktop pane uses,
 * so markdown autoformatting and paste handling behave identically and
 * a draft typed on one form factor reads the same on the other.
 *
 * Attachments upload to the BE and their absolute paths are appended to
 * the message, which is how the agent's Read tool reaches them.
 */
export default function Composer(props: {
  disabled?: boolean;
  streaming: boolean;
  onSend: (body: string) => void | Promise<void>;
  onStop: () => void;
}) {
  const [text, setText] = createSignal("");
  const [uploads, setUploads] = createSignal<UploadDto[]>([]);
  const [uploading, setUploading] = createSignal(false);
  let composer: ChatComposerHandle | null = null;
  let filePicker: HTMLInputElement | undefined;

  const canSend = () => !props.disabled && (text().trim().length > 0 || uploads().length > 0);

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const done = await api.uploadFiles(files);
      setUploads((prev) => [...prev, ...done]);
    } catch {
      // Surfaced by the chip row simply not growing; the user can retry.
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    if (!canSend()) return;
    let body = text().trim();
    const atts = uploads();
    if (atts.length > 0) {
      const lines = atts
        .map((u) => `- ${u.path}${u.content_type ? ` (${u.content_type})` : ""}`)
        .join("\n");
      body = `${body}${body ? "\n\n" : ""}Attached files (absolute paths, read with your Read tool):\n${lines}`;
    }
    // Clear before awaiting so the field empties the instant the user
    // taps, rather than sitting full for a round-trip.
    setText("");
    setUploads([]);
    composer?.setMarkdown("");
    void props.onSend(body);
  }

  return (
    <div
      class="shrink-0 border-t border-border bg-bg-1 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2"
      data-testid="mobile-composer"
    >
      <Show when={uploads().length > 0 || uploading()}>
        <div class="mb-2 flex flex-wrap gap-1.5 px-1" data-testid="mobile-uploads">
          <For each={uploads()}>
            {(u) => (
              <span class="ag-chip flex items-center gap-1 text-[11.5px]">
                <span class="max-w-[140px] truncate">{u.filename}</span>
                <button
                  type="button"
                  class="text-fg-subtle active:text-danger"
                  onClick={() => setUploads((prev) => prev.filter((x) => x.id !== u.id))}
                  aria-label={`Remove ${u.filename}`}
                >
                  ✕
                </button>
              </span>
            )}
          </For>
          <Show when={uploading()}>
            <span class="ag-chip text-[11.5px] italic text-fg-subtle">Uploading…</span>
          </Show>
        </div>
      </Show>

      <div class="flex items-end gap-1.5">
        <input
          ref={(el) => (filePicker = el)}
          type="file"
          multiple
          class="hidden"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            void upload(files);
          }}
          data-testid="mobile-file-input"
        />
        <button
          type="button"
          class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-10 shrink-0 text-fg-subtle"
          onClick={() => filePicker?.click()}
          aria-label="Attach files"
          data-testid="mobile-attach"
        >
          <PlusIcon size={19} />
        </button>

        <div class="max-h-40 min-w-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-bg-2 px-3 py-2">
          <ChatComposer
            value={text()}
            onChange={setText}
            onSubmit={submit}
            onPasteFiles={(files) => void upload(files)}
            /* Enter inserts a newline on a phone keyboard; sending is the
               button's job. Returning false lets Tiptap keep its defaults. */
            onKey={() => false}
            placeholder="Message…"
            {...(props.disabled ? { disabled: true } : {})}
            ref={(h) => (composer = h)}
            testId="mobile-chat-input"
          />
        </div>

        {/* Only committed segments are inserted; interim chunks would
            land in the document and then be re-sent as final text. */}
        <MicButton
          onTranscript={(t, isFinal) => {
            if (isFinal) composer?.insertAtCursor(t);
          }}
        />

        <Show
          when={props.streaming}
          fallback={
            <button
              type="button"
              class="ag-btn ag-btn-primary ag-btn-icon !h-11 !w-11 shrink-0 rounded-full"
              disabled={!canSend()}
              onClick={submit}
              aria-label="Send message"
              data-testid="mobile-send"
            >
              <SendIcon size={19} />
            </button>
          }
        >
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-icon !h-11 !w-11 shrink-0 rounded-full text-danger"
            onClick={props.onStop}
            aria-label="Stop the agent"
            data-testid="mobile-stop"
          >
            <StopIcon size={17} />
          </button>
        </Show>
      </div>
    </div>
  );
}
