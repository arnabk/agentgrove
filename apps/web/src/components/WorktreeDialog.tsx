import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { api } from "../api/client";
import { refreshWorktreesForProject, state } from "../stores/app";
import { suggestBranchName } from "../lib/celestial";

interface Props {
  projectId: string;
  defaultBaseRef?: string | undefined;
  onCancel: () => void;
  onCreated: () => void;
}

/** Create-worktree dialog. Branch is required; base ref defaults to the
 *  project's current branch (or `main`). Pre-script is optional. */
export default function WorktreeDialog(props: Props) {
  // Branches taken by *live* worktrees for this project (from store).
  const liveBranches = () => new Set((state.worktrees[props.projectId] ?? []).map((w) => w.branch));

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
  // Whether the per-worktree override block is expanded. Stays
  // collapsed by default so the common case (use the project script,
  // or none at all) shows a quiet dialog.
  const [showOverride, setShowOverride] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  /** Lifecycle phase of the dialog body:
   *
   *   - "form"   — initial entry (branch / base / pre-script inputs)
   *   - "running" — POST returned an id; the BE is doing git +
   *     pre-script work and streaming events to the WS topic. The
   *     console replaces the form.
   *   - "ready"  — BE flipped status to `ready`. Show a Done button.
   *   - "failed" — BE flipped status to `failed`. Show the console
   *     (so the user can see what went wrong) + a Close button. */
  type Phase = "form" | "running" | "ready" | "failed";
  const [phase, setPhase] = createSignal<Phase>("form");

  // Auto-close on full success: when the worktree-add + the
  // optional pre-script both finish cleanly the row flips to
  // `ready`, which the poll loop reflects into phase="ready".
  // Close the dialog one short beat later so the user has a
  // chance to glance at the final console output before it
  // disappears. Failures stay open until the user dismisses
  // them so they can read what went wrong (see the explicit
  // `Close` button rendered in the `failed` branch).
  let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    if (phase() === "ready") {
      if (autoCloseTimer) clearTimeout(autoCloseTimer);
      autoCloseTimer = setTimeout(() => {
        autoCloseTimer = null;
        finish();
      }, 600);
    } else if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  });
  onCleanup(() => {
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
  });
  /** Buffered console lines from the WS topic. Each entry is a
   *  parsed payload (`stage`, `stdout`, `stderr`, `exit`, `info`).
   *  Capped at 2000 lines defensively — most worktree creations emit
   *  fewer than 50. */
  interface ConsoleLine {
    kind: "stage" | "stdout" | "stderr" | "exit" | "info";
    text: string;
  }
  const [consoleLines, setConsoleLines] = createSignal<ConsoleLine[]>([]);
  /** Id of the just-created worktree (so the dialog can keep
   *  watching it). */
  const [createdId, setCreatedId] = createSignal<string | null>(null);
  let socket: WebSocket | null = null;
  let consoleHost: HTMLDivElement | null = null;
  let statusPoll: ReturnType<typeof setInterval> | null = null;

  onCleanup(() => {
    try {
      socket?.close();
    } catch {
      // ignore
    }
    if (statusPoll !== null) clearInterval(statusPoll);
  });

  function pushConsole(line: ConsoleLine) {
    setConsoleLines((cur) => {
      const next = [...cur, line];
      if (next.length > 2000) next.splice(0, next.length - 2000);
      return next;
    });
    // Scroll the console to the bottom after the row renders.
    queueMicrotask(() => {
      if (consoleHost) consoleHost.scrollTop = consoleHost.scrollHeight;
    });
  }

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
      const created = await api.createWorktree(props.projectId, body);
      setCreatedId(created.id);
      // The BE row exists from this point on (status = creating,
      // then pre_script, then ready/failed). Push an immediate refresh
      // into the parent's worktree list so the row appears in the
      // LeftRail right away — even if the user closes the dialog mid-
      // flight, or if the eventual `failed` outcome would otherwise
      // require a manual page refresh to surface.
      void refreshWorktreesForProject(props.projectId);
      // Flip the dialog into "running" mode so the user sees the live
      // console while git + the pre-script work in the background.
      setPhase("running");
      pushConsole({ kind: "info", text: `worktree id = ${created.id}` });
      subscribeToTopic(created.id);
      pollStatus(created.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Subscribe to `worktree:{id}:script` and translate each WS frame
   *  into a console line. The BE's LogBus history replay ensures we
   *  catch up on any events emitted before the socket finished
   *  upgrading. */
  function subscribeToTopic(wtId: string) {
    const apiBase = api.baseUrl() || window.location.origin;
    const url = new URL(apiBase, window.location.origin);
    url.protocol = url.protocol.startsWith("https") ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("topic", `worktree:${wtId}:script`);
    try {
      socket = new WebSocket(url.toString());
    } catch (e) {
      pushConsole({
        kind: "stderr",
        text: `failed to open WS: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    socket.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const m = parsed as {
        type?: string;
        line?: string;
        stage?: string;
        code?: number;
        subscribed?: string;
      };
      if (m.subscribed) return;
      switch (m.type) {
        case "stage":
          pushConsole({ kind: "stage", text: `[${m.stage}]` });
          break;
        case "stdout":
          pushConsole({ kind: "stdout", text: m.line ?? "" });
          break;
        case "stderr":
          pushConsole({ kind: "stderr", text: m.line ?? "" });
          break;
        case "exit":
          pushConsole({
            kind: "exit",
            text: `[exit ${m.code ?? "?"}]`,
          });
          break;
        default:
          // Unknown frame — show raw text for visibility.
          pushConsole({ kind: "stdout", text: ev.data });
      }
    });
  }

  /** Poll the project's worktree list until our created worktree
   *  reaches a terminal status. Stops the timer in either branch.
   *  Each tick we route through `refreshWorktreesForProject` so the
   *  global store stays in lock-step with the BE — this is what makes
   *  the LeftRail row appear as soon as it transitions to `failed`,
   *  rather than waiting for the user to close the dialog. */
  function pollStatus(wtId: string) {
    statusPoll = setInterval(async () => {
      try {
        await refreshWorktreesForProject(props.projectId);
        const me = (state.worktrees[props.projectId] ?? []).find((w) => w.id === wtId);
        if (!me) return;
        if (me.status === "ready") {
          if (statusPoll !== null) clearInterval(statusPoll);
          statusPoll = null;
          setPhase("ready");
        } else if (me.status === "failed") {
          if (statusPoll !== null) clearInterval(statusPoll);
          statusPoll = null;
          setPhase("failed");
        }
      } catch {
        // ignore — poll continues
      }
    }, 500);
  }

  function finish() {
    setPhase("form");
    setConsoleLines([]);
    setCreatedId(null);
    try {
      socket?.close();
    } catch {
      // ignore
    }
    socket = null;
    props.onCreated();
  }

  /** Color class for a single console row. Stage = accent, stderr =
   *  danger, exit = warning when non-zero, info = muted. */
  function lineClass(kind: ConsoleLine["kind"]): string {
    switch (kind) {
      case "stage":
        return "text-accent";
      case "stderr":
        return "text-danger";
      case "exit":
        return "text-warning";
      case "info":
        return "text-fg-muted";
      default:
        return "text-fg";
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
        onClick={() => {
          // Backdrop click should NOT cancel while the BE is mid-flight.
          if (busy() || phase() === "running") return;
          props.onCancel();
        }}
      />
      <Show
        when={phase() === "form"}
        fallback={
          <div
            class="relative w-full max-w-2xl rounded-xl border border-border bg-bg-1 p-6 shadow-2xl"
            data-testid="worktree-dialog-running"
            data-worktree-id={createdId() ?? ""}
          >
            <h3 class="text-[15px] font-semibold mb-1">
              <Show when={phase() === "running"}>Creating worktree…</Show>
              <Show when={phase() === "ready"}>Worktree ready</Show>
              <Show when={phase() === "failed"}>Worktree failed</Show>
            </h3>
            <p class="text-[13px] text-fg-muted mb-4 font-mono break-all">{branch()}</p>
            <div
              ref={(el) => (consoleHost = el)}
              class="h-72 overflow-auto rounded-md border border-border bg-bg-0 p-3 font-mono text-[12px] leading-[1.5]"
              data-testid="worktree-console"
            >
              <Show
                when={consoleLines().length > 0}
                fallback={<span class="text-fg-subtle">Waiting for output…</span>}
              >
                <For each={consoleLines()}>
                  {(line) => (
                    <div class={`whitespace-pre-wrap ${lineClass(line.kind)}`}>{line.text}</div>
                  )}
                </For>
              </Show>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <Show when={phase() === "running"}>
                <button
                  type="button"
                  class="ag-btn ag-btn-ghost"
                  disabled
                  title="Cannot cancel while the worktree is being created"
                >
                  Working…
                </button>
              </Show>
              <Show when={phase() === "ready"}>
                <button
                  type="button"
                  class="ag-btn ag-btn-primary"
                  onClick={finish}
                  data-testid="worktree-done"
                  autofocus
                >
                  Done
                </button>
              </Show>
              <Show when={phase() === "failed"}>
                <button
                  type="button"
                  class="ag-btn ag-btn-ghost"
                  onClick={() => {
                    // The worktree row WAS created on the BE — git
                    // worktree add succeeded but the pre-script later
                    // exited non-zero, so the row is sitting in
                    // `failed` state. We MUST call onCreated() here
                    // (not onCancel) so the parent refreshes its
                    // worktree list and surfaces the failed row to
                    // the user. Calling onCancel would leave the row
                    // invisible until the next manual page refresh,
                    // which was the bug report.
                    try {
                      socket?.close();
                    } catch {
                      // ignore
                    }
                    socket = null;
                    props.onCreated();
                  }}
                  data-testid="worktree-close"
                  autofocus
                >
                  Close
                </button>
              </Show>
            </div>
          </div>
        }
      >
        <form
          onSubmit={submit}
          class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 p-6 shadow-2xl"
        >
          <h3 class="text-[15px] font-semibold mb-1">New worktree</h3>
          <p class="text-[13px] text-fg-muted mb-5">
            AgentGrove will run <code class="font-mono">git worktree add</code> for this branch and
            (optionally) execute a pre-script in the new worktree before marking it ready.
          </p>

          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-[12px] font-medium text-fg-muted">Branch name</label>
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

          <label class="block text-[12px] font-medium text-fg-muted mb-1.5">Base ref</label>
          <input
            class="ag-input font-mono mb-4"
            placeholder="main"
            value={baseRef()}
            onInput={(e) => setBaseRef(e.currentTarget.value)}
            data-testid="worktree-base-ref"
          />

          {/*
            Pre-worktree script. We removed the always-visible input
            here because developers don't want to retype `pnpm install`
            on every dialog — the canonical place for that command is
            now Project settings.

            Three states:
              1. Project has a script → show a read-only "Will run:"
                 hint so the user knows what to expect.
              2. Project has no script → render the optional override
                 input collapsed behind a small "Add a one-off
                 script…" disclosure, keeping the dialog short for
                 the common case.
              3. Override expanded → free-form textarea identical to
                 the legacy field, but explicitly framed as overriding
                 the (possibly empty) project default.
          */}
          {(() => {
            const inherited = () => {
              const proj = state.projects.find((p) => p.id === props.projectId);
              return (proj?.pre_worktree_script ?? "").trim();
            };
            return (
              <>
                <Show when={inherited()}>
                  <label class="block text-[12px] font-medium text-fg-muted mb-1.5">
                    Pre-worktree script
                  </label>
                  <pre
                    class="ag-input font-mono mb-1 whitespace-pre-wrap text-[12px] !cursor-default opacity-90"
                    data-testid="worktree-inherited-script"
                  >
                    {inherited()}
                  </pre>
                  <p class="text-[11px] text-fg-subtle mb-4">
                    Inherited from project settings. Edit there to change the default for every new
                    worktree.
                  </p>
                </Show>

                <Show when={!showOverride()}>
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost ag-btn-xs mb-5"
                    onClick={() => setShowOverride(true)}
                    data-testid="worktree-show-override"
                  >
                    {inherited()
                      ? "+ Override script for this worktree"
                      : "+ Add a one-off pre-script (not saved to project)"}
                  </button>
                </Show>

                <Show when={showOverride()}>
                  <label class="block text-[12px] font-medium text-fg-muted mb-1.5">
                    {inherited() ? "Override (this worktree only)" : "One-off pre-script"}
                  </label>
                  <textarea
                    rows="3"
                    class="ag-input font-mono mb-2 resize-y"
                    placeholder="pnpm install"
                    value={preScript()}
                    onInput={(e) => setPreScript(e.currentTarget.value)}
                    data-testid="worktree-pre-script"
                  />
                  <p class="text-[11px] text-fg-subtle mb-5">
                    Runs inside the new worktree after creation. Leave blank to fall back to the
                    project default
                    {inherited() ? " above." : "."}
                  </p>
                </Show>
              </>
            );
          })()}

          <Show when={err()}>
            <p class="mb-4 text-[12px] text-danger" data-testid="worktree-error">
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
      </Show>
    </div>
  );
}
