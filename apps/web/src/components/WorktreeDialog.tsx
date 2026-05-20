import { Show, createSignal, onMount } from "solid-js";
import { api } from "../api/client";
import { state } from "../stores/app";

interface Props {
  projectId: string;
  defaultBaseRef?: string | undefined;
  onCancel: () => void;
  onCreated: () => void;
}

const ADJECTIVES = [
  "swift",
  "bold",
  "calm",
  "brave",
  "clever",
  "lucky",
  "merry",
  "quiet",
  "sharp",
  "shiny",
  "spry",
  "vivid",
  "zesty",
  "amber",
  "azure",
  "coral",
  "ember",
  "frost",
  "ivory",
  "jade",
  "olive",
  "pearl",
  "rusty",
  "snowy",
  "sunny",
  "balmy",
  "breezy",
  "dapper",
  "dusty",
  "feisty",
  "glossy",
  "humble",
  "jolly",
  "noble",
  "plucky",
  "rosy",
  "silky",
  "tidy",
  "wily",
  "zippy",
];

const NOUNS = [
  "otter",
  "lynx",
  "panda",
  "robin",
  "heron",
  "finch",
  "raven",
  "marten",
  "puffin",
  "newt",
  "axolotl",
  "owl",
  "fox",
  "moth",
  "salmon",
  "krill",
  "tigerlily",
  "fern",
  "cedar",
  "willow",
  "alder",
  "moss",
  "comet",
  "nebula",
  "ember",
  "harbor",
  "meadow",
  "ridge",
  "summit",
  "delta",
  "cove",
  "anchor",
  "lantern",
  "compass",
  "atlas",
  "loom",
  "quill",
  "ledger",
  "satchel",
  "anvil",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Suggest a branch name that doesn't collide with any in `taken`. */
function suggestBranchName(taken: Set<string>): string {
  // 80 × 80 namespace; collisions are extremely rare. We still retry with
  // a numeric suffix as a final fallback so we never return a duplicate.
  for (let attempt = 0; attempt < 25; attempt++) {
    const name = `feature/${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  // Last resort: append a counter.
  let n = 2;
  while (true) {
    const name = `feature/${pick(ADJECTIVES)}-${pick(NOUNS)}-${n}`;
    if (!taken.has(name)) return name;
    n++;
    if (n > 10_000) return `feature/branch-${Date.now()}`;
  }
}

/** Create-worktree dialog. Branch is required; base ref defaults to the
 *  project's current branch (or `main`). Pre-script is optional. */
export default function WorktreeDialog(props: Props) {
  const takenBranches = () =>
    new Set((state.worktrees[props.projectId] ?? []).map((w) => w.branch));

  const [branch, setBranch] = createSignal("");
  const [baseRef, setBaseRef] = createSignal(props.defaultBaseRef ?? "main");
  const [preScript, setPreScript] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  // Seed a suggestion the first time the dialog opens.
  onMount(() => {
    if (!branch().trim()) {
      setBranch(suggestBranchName(takenBranches()));
    }
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
    if (takenBranches().has(b)) {
      setErr(`A worktree on '${b}' already exists. Pick a different name.`);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const body: {
        branch: string;
        base_ref: string;
        pre_script?: string;
      } = { branch: b, base_ref: baseRef().trim() || "main" };
      if (preScript().trim()) body.pre_script = preScript();
      await api.createWorktree(props.projectId, body);
      props.onCreated();
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
      aria-label="Create worktree"
      data-testid="worktree-dialog"
    >
      <div
        class="absolute inset-0 bg-black/60"
        onClick={() => !busy() && props.onCancel()}
      />
      <form
        onSubmit={submit}
        class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 p-6 shadow-2xl"
      >
        <h3 class="text-[15px] font-semibold mb-1">New worktree</h3>
        <p class="text-[13px] text-fg-muted mb-5">
          AgentGrove will run <code class="font-mono">git worktree add</code>{" "}
          for this branch and (optionally) execute a pre-script in the new
          worktree before marking it ready.
        </p>

        <div class="flex items-center justify-between mb-1.5">
          <label class="block text-[12px] font-medium text-fg-muted">
            Branch name
          </label>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={reroll}
            title="Suggest another name"
            data-testid="worktree-suggest"
          >
            ✦ Suggest
          </button>
        </div>
        <input
          class="ag-input font-mono mb-4"
          placeholder="feature/my-change"
          value={branch()}
          onInput={(e) => setBranch(e.currentTarget.value)}
          data-testid="worktree-branch"
          autofocus
        />

        <label class="block text-[12px] font-medium text-fg-muted mb-1.5">
          Base ref
        </label>
        <input
          class="ag-input font-mono mb-4"
          placeholder="main"
          value={baseRef()}
          onInput={(e) => setBaseRef(e.currentTarget.value)}
          data-testid="worktree-base-ref"
        />

        <label class="block text-[12px] font-medium text-fg-muted mb-1.5">
          Pre-script (optional)
        </label>
        <input
          class="ag-input font-mono mb-2"
          placeholder="pnpm install"
          value={preScript()}
          onInput={(e) => setPreScript(e.currentTarget.value)}
          data-testid="worktree-pre-script"
        />
        <p class="text-[11px] text-fg-subtle mb-5">
          Runs inside the new worktree directory after creation. Leave blank
          to skip.
        </p>

        <Show when={err()}>
          <p
            class="mb-4 text-[12px] text-danger"
            data-testid="worktree-error"
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
            data-testid="worktree-submit"
          >
            {busy() ? "Creating…" : "Create worktree"}
          </button>
        </div>
      </form>
    </div>
  );
}
