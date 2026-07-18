import { Show, createSignal } from "solid-js";
import { api } from "../api/client";
import { refreshProjects, setSettingsOpen } from "../stores/app";
import FolderPicker from "./FolderPicker";
import Logo from "./Logo";

/**
 * Welcome screen shown when no projects exist. Clicking "Open a folder"
 * launches the native-feeling folder picker (BE-driven, since the browser
 * can't reveal absolute paths).
 */
export default function Welcome() {
  const [picking, setPicking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  async function onSelect(path: string) {
    setErr(null);
    setBusy(true);
    try {
      await api.createProject({ root: path });
      setPicking(false);
      await refreshProjects();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="h-full flex items-center justify-center px-8 py-12" data-testid="welcome">
      <div class="w-full max-w-2xl">
        {/* Hero */}
        <div class="flex items-center gap-3 mb-3">
          <Logo class="w-8 h-8" />
          <h1 class="text-3xl font-semibold tracking-tight">AgentGrove</h1>
        </div>
        <p class="text-fg-muted mb-10 text-[15px]">
          A local developer workspace built around your folders. Editor, terminals, git diff,
          scratchpad, prompt queue, and optional AI assistance — all per project. Start by adding a
          folder; git or not, both work.
        </p>

        {/* Action cards */}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            class="text-left rounded-xl border border-border bg-bg-1 p-5 hover:border-border-strong hover:bg-bg-2 transition-colors group"
            onClick={() => setPicking(true)}
            disabled={busy()}
            data-testid="welcome-add-folder"
          >
            <div class="flex items-center gap-3 mb-2">
              <span class="w-9 h-9 rounded-md bg-accent-soft flex items-center justify-center text-accent">
                <FolderIcon />
              </span>
              <h2 class="text-[15px] font-semibold">Open a folder</h2>
            </div>
            <p class="text-[13px] text-fg-muted">
              Pick a folder on disk. Its name becomes the project name.
            </p>
            <p class="mt-3 text-[12px] text-fg-subtle group-hover:text-fg-muted">
              Browse folders →
            </p>
          </button>

          <a
            class="text-left rounded-xl border border-border bg-bg-1 p-5 hover:border-border-strong hover:bg-bg-2 transition-colors group"
            href="https://github.com/agentgrove/agentgrove"
            target="_blank"
            rel="noreferrer"
            data-testid="welcome-docs"
          >
            <div class="flex items-center gap-3 mb-2">
              <span class="w-9 h-9 rounded-md bg-accent-soft flex items-center justify-center text-accent">
                <BookIcon />
              </span>
              <h2 class="text-[15px] font-semibold">Read the docs</h2>
            </div>
            <p class="text-[13px] text-fg-muted">
              How projects, the editor, terminals, diff, and (optional) AI fit together.
            </p>
            <p class="mt-3 text-[12px] text-fg-subtle group-hover:text-fg-muted">
              Open documentation →
            </p>
          </a>
        </div>

        {/* Tips */}
        <div class="mt-10 text-[13px] text-fg-subtle space-y-1.5">
          <button
            type="button"
            class="flex items-center gap-1 hover:text-fg transition-colors"
            onClick={() => setSettingsOpen(true)}
            data-testid="welcome-open-settings"
            title="Open settings"
          >
            <span class="ag-kbd">⌘</span> + <span class="ag-kbd">,</span>
            <span class="ml-2">Open settings</span>
          </button>
          <div class="opacity-60">
            <span class="ag-kbd">⌘</span> + <span class="ag-kbd">K</span>
            <span class="ml-2">Command palette (coming soon)</span>
          </div>
        </div>

        <Show when={err()}>
          <p class="mt-6 text-[12px] text-danger" data-testid="welcome-error">
            {err()}
          </p>
        </Show>

        <Show when={picking()}>
          <FolderPicker onSelect={(p) => void onSelect(p)} onCancel={() => setPicking(false)} />
        </Show>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
      <path d="M4 19a2 2 0 0 0 2 2h12" stroke="currentColor" stroke-width="1.7" />
    </svg>
  );
}
