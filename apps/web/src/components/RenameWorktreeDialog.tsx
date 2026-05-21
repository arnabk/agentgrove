import { Show, createSignal, onMount } from "solid-js";
import { api } from "../api/client";
import { state } from "../stores/app";

interface Props {
  projectId: string;
  worktreeId: string;
  currentBranch: string;
  onCancel: () => void;
  onRenamed: () => void;
}

const ADJECTIVES = [
  "swift", "bold", "calm", "brave", "clever", "lucky", "merry", "quiet",
  "sharp", "shiny", "spry", "vivid", "zesty", "amber", "azure", "coral",
  "ember", "frost", "ivory", "jade", "olive", "pearl", "rusty", "snowy",
  "sunny", "balmy", "breezy", "dapper", "dusty", "feisty", "glossy",
  "humble", "jolly", "noble", "plucky", "rosy", "silky", "tidy", "wily",
  "zippy",
];

const NOUNS = [
  "otter", "lynx", "panda", "robin", "heron", "finch", "raven", "marten",
  "puffin", "newt", "axolotl", "owl", "fox", "moth", "salmon", "krill",
  "tigerlily", "fern", "cedar", "willow", "alder", "moss", "comet",
  "nebula", "ember", "harbor", "meadow", "ridge", "summit", "delta",
  "cove", "anchor", "lantern", "compass", "atlas", "loom", "quill",
  "ledger", "satchel", "anvil",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Same tiered strategy as WorktreeDialog. Kept in sync deliberately:
 *  the BE applies an identical collision check across live + history
 *  worktrees, so both create + rename surfaces should suggest names
 *  that pass the same filter. */
function suggestBranchName(taken: Set<string>): string {
  for (let attempt = 0; attempt < 25; attempt++) {
    const name = `feature/${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  for (const a of ADJECTIVES) {
    for (const n of NOUNS) {
      const name = `feature/${a}-${n}`;
      if (!taken.has(name)) return name;
    }
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const suffix = Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
    const name = `feature/${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
    if (!taken.has(name)) return name;
  }
  return `feature/branch-${Date.now().toString(36)}`;
}

/** Rename-worktree dialog. Renames the branch (`git branch -m`) and
 *  updates the metadata row. The on-disk path is left in place per the
 *  product decision — keeps the layout stable across renames. */
export default function RenameWorktreeDialog(props: Props) {
  const liveBranches = () =>
    new Set(
      (state.worktrees[props.projectId] ?? [])
        .filter((w) => w.id !== props.worktreeId)
        .map((w) => w.branch),
    );
  const [historyBranches, setHistoryBranches] = createSignal<Set<string>>(new Set());
  const takenBranches = () => {
    const out = new Set<string>();
    for (const b of liveBranches()) out.add(b);
    for (const b of historyBranches()) out.add(b);
    return out;
  };

  const [branch, setBranch] = createSignal(props.currentBranch);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  onMount(() => {
    void api
      .listWorktreeHistory({ projectId: props.projectId })
      .then((entries) => {
        setHistoryBranches(new Set(entries.map((w) => w.branch)));
      })
      .catch(() => {
        // ignore — fall back to live-only collision set
      });
  });

  function reroll() {
    setBranch(suggestBranchName(takenBranches()));
  }

  async function submit(ev: SubmitEvent) {
    ev.preventDefault();
    const b = branch().trim();
    if (!b) {
      setErr("Branch name is required.");
      return;
    }
    if (b === props.currentBranch) {
      // Idempotent no-op — just close.
      props.onCancel();
      return;
    }
    if (takenBranches().has(b)) {
      setErr(`A worktree on '${b}' already exists. Pick a different name.`);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await api.renameWorktree(props.projectId, props.worktreeId, b);
      props.onRenamed();
    } catch (e) {
      // The BE returns 409 on conflicts; bubble up the message verbatim
      // so the user sees the exact reason (live vs history collision,
      // or `git branch -m` refusal).
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
      aria-label="Rename worktree"
      data-testid="rename-worktree-dialog"
    >
      <div
        class="absolute inset-0 bg-black/60"
        onClick={() => !busy() && props.onCancel()}
      />
      <form
        onSubmit={submit}
        class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 p-6 shadow-2xl"
      >
        <h3 class="text-[15px] font-semibold mb-1">Rename worktree</h3>
        <p class="text-[13px] text-fg-muted mb-5">
          Renames the branch via{" "}
          <code class="font-mono">git branch -m</code>. The worktree
          directory on disk keeps its current path.
        </p>

        <div class="flex items-center justify-between mb-1.5">
          <label class="block text-[12px] font-medium text-fg-muted">
            New branch name
          </label>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={reroll}
            title="Suggest another name"
            data-testid="rename-suggest"
          >
            ✦ Suggest
          </button>
        </div>
        <input
          class="ag-input font-mono mb-2"
          placeholder="feature/my-change"
          value={branch()}
          onInput={(e) => setBranch(e.currentTarget.value)}
          data-testid="rename-branch"
          autofocus
        />
        <p class="text-[11px] text-fg-subtle mb-5 font-mono break-all">
          was {props.currentBranch}
        </p>

        <Show when={err()}>
          <p
            class="mb-4 text-[12px] text-danger"
            data-testid="rename-error"
          >
            {err()}
          </p>
        </Show>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="ag-btn ag-btn-ghost"
            onClick={() => props.onCancel()}
            disabled={busy()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="ag-btn ag-btn-primary"
            disabled={busy()}
            data-testid="rename-submit"
          >
            {busy() ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </div>
  );
}
