import { For, Show, createSignal, onMount } from "solid-js";
import { api, type ChatView, type SlashCommand } from "../api/client";
import Select from "./Select";

/** Per-chat configuration dialog: model, effort, slash-commands.
 *  Mounted from inside ChatPane when the user clicks the provider
 *  chip in the chat-tab strip. Changes round-trip through the BE's
 *  PATCH /api/chats/:id route. */
interface Props {
  chat: ChatView;
  onClose: () => void;
  /** Called with the updated ChatView after any save. */
  onUpdated: (chat: ChatView) => void;
  /** Called when the user picks a slash-command. Caller inserts it
   *  into the chat input. */
  onInsertCommand: (name: string) => void;
}

/** Effort levels Claude's CLI recognises. Other providers may
 *  ignore the field entirely. */
const EFFORT_LEVELS = [
  { value: "", label: "Default (provider decides)" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export default function ChatSettingsDialog(props: Props) {
  const [model, setModel] = createSignal(props.chat.model);
  const [effort, setEffort] = createSignal(props.chat.effort ?? "");
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  onMount(() => {
    void (async () => {
      try {
        // Pass project_id so user-authored project-scoped commands
        // (`<project>/.claude/commands/*.md`) appear alongside the
        // built-ins.
        const cmds = await api.listProviderCommands(props.chat.provider, props.chat.project_id);
        setCommands(cmds);
      } catch (e) {
        // Slash commands are optional — non-fatal.
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  });

  async function saveModel() {
    const trimmed = model().trim();
    if (!trimmed) {
      setErr("Model cannot be empty.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const updated = await api.updateChat(props.chat.id, { model: trimmed });
      props.onUpdated(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEffort(v: string) {
    setEffort(v);
    setBusy(true);
    setErr(null);
    try {
      // Empty string -> null (clear), otherwise set.
      const updated = await api.updateChat(props.chat.id, {
        effort: v ? v : null,
      });
      props.onUpdated(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Chat settings"
      data-testid="chat-settings-dialog"
    >
      <div class="absolute inset-0 bg-black/60" onClick={() => !busy() && props.onClose()} />
      <div class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        <header class="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <h3 class="text-[14px] font-semibold tracking-tight">Chat settings</h3>
            <p class="text-[11.5px] text-fg-subtle">
              Provider: <span class="font-mono">{props.chat.provider}</span> · session is preserved
              across edits except when the model changes (resume tokens are model-specific).
            </p>
          </div>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-icon"
            onClick={() => props.onClose()}
            aria-label="Close"
            data-testid="chat-settings-close"
          >
            ✕
          </button>
        </header>

        <div class="px-5 py-4 space-y-5 overflow-y-auto">
          <div>
            <label class="block text-[12.5px] font-medium text-fg mb-1">Model</label>
            <p class="text-[11.5px] text-fg-subtle mb-2">
              Provider alias (e.g. <code class="font-mono">sonnet</code>,{" "}
              <code class="font-mono">opus</code>) or a full model id.
            </p>
            <div class="flex gap-2">
              <input
                class="ag-input font-mono flex-1"
                value={model()}
                onInput={(e) => setModel(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveModel();
                  }
                }}
                disabled={busy()}
                data-testid="chat-settings-model"
              />
              <button
                class="ag-btn ag-btn-primary"
                onClick={() => void saveModel()}
                disabled={busy() || model().trim() === props.chat.model}
                data-testid="chat-settings-save-model"
              >
                Save
              </button>
            </div>
          </div>

          <div>
            <label class="block text-[12.5px] font-medium text-fg mb-1">Thinking effort</label>
            <p class="text-[11.5px] text-fg-subtle mb-2">
              Reserved budget for the model's reasoning. Higher values produce more thorough answers
              but cost more tokens. Only Claude uses this today.
            </p>
            <Select
              value={effort()}
              options={EFFORT_LEVELS}
              onChange={(v) => void saveEffort(v)}
              disabled={busy()}
              ariaLabel="Thinking effort"
              testId="chat-settings-effort"
            />
          </div>

          <Show when={commands().length > 0}>
            <div>
              <label class="block text-[12.5px] font-medium text-fg mb-1">Slash commands</label>
              <p class="text-[11.5px] text-fg-subtle mb-2">
                Built-in commands the provider's CLI exposes. Click to drop one into the chat input.
              </p>
              <ul class="space-y-1">
                <For each={commands()}>
                  {(c) => (
                    <li>
                      <button
                        type="button"
                        class="w-full text-left px-3 py-1.5 rounded hover:bg-bg-2 border border-border"
                        onClick={() => props.onInsertCommand(c.name)}
                        data-testid={`chat-settings-command-${c.name}`}
                      >
                        <span class="font-mono text-fg">/{c.name}</span>
                        <span class="ml-2 text-[11.5px] text-fg-subtle">{c.description}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          <Show when={err()}>
            <p class="text-[12px] text-danger" data-testid="chat-settings-error">
              {err()}
            </p>
          </Show>
        </div>

        <footer class="flex items-center justify-end px-5 py-3 border-t border-border">
          <button
            class="ag-btn ag-btn-primary"
            onClick={() => props.onClose()}
            data-testid="chat-settings-done"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
