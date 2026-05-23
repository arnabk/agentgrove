import { Show, createSignal, onMount } from "solid-js";
import { api, type Project } from "../api/client";

interface Props {
  project: Project;
  onCancel: () => void;
  /** Called with the updated project after a successful save so the
   *  caller can refresh its local store. The dialog closes itself
   *  immediately after invoking this — callers should NOT also call
   *  `onCancel` from within `onSaved`. */
  onSaved: (updated: Project) => void;
}

/** Project-level configuration. Today the dialog hosts a single
 *  field — the pre-worktree script — but the layout is shaped for
 *  growth: more fields slot in below the script editor without
 *  redesigning anything.
 *
 *  Why this matters: developers spin up many worktrees per project
 *  and don't want to retype `pnpm install` (or whatever the
 *  bootstrap chant is) on every dialog. Storing it at the project
 *  level means new worktrees inherit it automatically. A blank
 *  field clears the project default; the worktree dialog still
 *  accepts an ad-hoc override for one-off branches. */
export default function ProjectSettingsDialog(props: Props) {
  const [script, setScript] = createSignal(props.project.pre_worktree_script ?? "");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  // Focus the textarea on mount so the user can paste straight in.
  let scriptEl: HTMLTextAreaElement | undefined;
  onMount(() => {
    queueMicrotask(() => scriptEl?.focus());
  });

  /** Save the current script value. Empty / whitespace-only is sent
   *  as an empty string, which the BE interprets as "clear" — so a
   *  user who wants to remove the default just blanks the field and
   *  hits Save.
   *
   *  Success path closes the dialog: the closure is itself the
   *  confirmation, and a chip that flashed while the dialog stayed
   *  open just confused users into thinking nothing happened. Errors
   *  keep the dialog open with the message visible so the user can
   *  retry or copy the text. */
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const updated = await api.updateProject(props.project.id, {
        pre_worktree_script: script(),
      });
      props.onSaved(updated);
      props.onCancel();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const dirty = () => (script() ?? "") !== (props.project.pre_worktree_script ?? "");

  function handleKeyDown(e: KeyboardEvent) {
    // Cmd/Ctrl+Enter = save without forcing a click on the button.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (dirty()) void save();
    }
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Project settings"
      data-testid="project-settings-dialog"
    >
      <div class="absolute inset-0 bg-black/60" onClick={() => !busy() && props.onCancel()} />
      <div
        class="relative w-full max-w-xl rounded-xl border border-border bg-bg-1 p-6 shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <h3 class="text-[15px] font-semibold mb-1">Project settings</h3>
        <p class="text-[13px] text-fg-muted mb-5 font-mono break-all">
          {props.project.name} <span class="text-fg-subtle">· {props.project.root}</span>
        </p>

        <label class="block text-[12px] font-medium text-fg-muted mb-1.5">
          Pre-worktree script
        </label>
        <p class="text-[11.5px] text-fg-subtle mb-2">
          Runs inside every NEW worktree of this project after{" "}
          <code class="font-mono">git worktree add</code>. Use it for dependency installs, code-gen,
          or anything else a fresh checkout needs. Leave blank to clear. Two env vars are available:{" "}
          <code class="font-mono">$AGENTGROVE_PROJECT_ROOT</code> (this project's source folder) and{" "}
          <code class="font-mono">$AGENTGROVE_WORKTREE_PATH</code> (the new worktree dir, also the
          script's cwd).
        </p>
        <textarea
          ref={(el) => (scriptEl = el)}
          rows="6"
          class="ag-input font-mono text-[12.5px] resize-y w-full"
          placeholder={'pnpm install\ncp "$AGENTGROVE_PROJECT_ROOT/.env.local" .\n# anything else…'}
          value={script()}
          onInput={(e) => setScript(e.currentTarget.value)}
          disabled={busy()}
          data-testid="project-settings-pre-script"
        />
        <p class="text-[11px] text-fg-subtle mt-2">
          Tip: ⌘/Ctrl + Enter saves. The script is interpreted by{" "}
          {/* Cross-platform: bash on Unix, pwsh on Windows. */}
          bash on Unix and PowerShell on Windows.
        </p>

        <Show when={err()}>
          <p class="mt-4 text-[12px] text-danger" data-testid="project-settings-error">
            {err()}
          </p>
        </Show>

        <div class="flex justify-end gap-2 mt-6">
          <button
            type="button"
            class="ag-btn ag-btn-ghost"
            onClick={() => props.onCancel()}
            disabled={busy()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="ag-btn ag-btn-primary"
            onClick={() => void save()}
            disabled={busy() || !dirty()}
            data-testid="project-settings-save"
          >
            {busy() ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
