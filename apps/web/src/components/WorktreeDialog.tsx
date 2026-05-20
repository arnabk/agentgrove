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

/**
 * Generate a non-colliding branch name under `feature/`.
 *
 * Strategy (tiered so common case stays human-readable):
 *
 * 1. Try up to 25 random `adjective-noun` picks. With 40×40 = 1,600
 *    combinations this almost always succeeds while the pool is
 *    lightly used (≤ ~500 names taken).
 * 2. Walk the full 1,600-pair space deterministically and return the
 *    first free pair. Guarantees a clean two-word name whenever ANY
 *    pair is still free.
 * 3. Append a short 4-hex suffix (`-7a3f`) to a random pair. Adds
 *    65,536 variants per pair → 104M total names. Effectively
 *    unbounded for any realistic workflow.
 * 4. Last-resort timestamp fallback so the function is total.
 */
function suggestBranchName(taken: Set<string>): string {
  // Tier 1: cheap random sampling.
  for (let attempt = 0; attempt < 25; attempt++) {
    const name = `feature/${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  // Tier 2: exhaustive scan of the pair space.
  for (const a of ADJECTIVES) {
    for (const n of NOUNS) {
      const name = `feature/${a}-${n}`;
      if (!taken.has(name)) return name;
    }
  }
  // Tier 3: hex-suffixed names — 16^4 = 65,536 variants per pair.
  for (let attempt = 0; attempt < 200; attempt++) {
    const suffix = Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
    const name = `feature/${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
    if (!taken.has(name)) return name;
  }
  // Tier 4: hard fallback. Timestamps are unique to the millisecond.
  return `feature/branch-${Date.now().toString(36)}`;
}

/** Create-worktree dialog. Branch is required; base ref defaults to the
 *  project's current branch (or `main`). Pre-script is optional. */
export default function WorktreeDialog(props: Props) {
  // Branches taken by *live* worktrees for this project (from store).
  const liveBranches = () =>
    new Set((state.worktrees[props.projectId] ?? []).map((w) => w.branch));

  // Branches present in *history* (soft-deleted). Fetched lazily on
  // mount so we don't suggest a name that collides with a record we
  // could later restore — and so git itself doesn't reject `worktree
  // add -b` for an existing branch.
  const [historyBranches, setHistoryBranches] = createSignal<Set<string>>(new Set());

  const takenBranches = () => {
    const out = new Set<string>();
    for (const b of liveBranches()) out.add(b);
    for (const b of historyBranches()) out.add(b);
    return out;
  };

  const [branch, setBranch] = createSignal("");
  const [baseRef, setBaseRef] = createSignal(props.defaultBaseRef ?? "main");
  const [preScript, setPreScript] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  // Seed a suggestion + load history on first open. History fetch is
  // best-effort; if it fails we fall back to the live-only taken set.
  onMount(() => {
    void api
      .listWorktreeHistory({ projectId: props.projectId })
      .then((entries) => {
        setHistoryBranches(new Set(entries.map((w) => w.branch)));
        // Re-seed once history is in if the user hasn't typed yet.
        if (!branch().trim()) {
          setBranch(suggestBranchName(takenBranches()));
        }
      })
      .catch(() => {
        // ignore — fall back to live-only suggestions
      });
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
