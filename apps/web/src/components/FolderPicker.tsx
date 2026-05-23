import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { api, type FsBrowse } from "../api/client";

interface FolderPickerProps {
  /** Optional initial path; defaults to /api/fs/home. */
  initial?: string;
  /** Called with an absolute path when the user clicks "Select this folder". */
  onSelect: (path: string) => void;
  onCancel: () => void;
}

/**
 * Modal folder picker. Browses the host filesystem via the BE.
 * Shows directories only, lets the user navigate via the breadcrumb
 * or by clicking into folders, and returns the absolute path of the
 * currently-listed directory.
 */
export default function FolderPicker(props: FolderPickerProps) {
  const [view, setView] = createSignal<FsBrowse | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [roots, setRoots] = createSignal<string[]>([]);

  async function navigate(path: string) {
    setLoading(true);
    setErr(null);
    try {
      const v = await api.fsBrowse(path);
      setView(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(async () => {
    try {
      const home = await api.fsHome();
      setRoots(home.roots);
      const start = props.initial?.trim() || home.home;
      await navigate(start);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") props.onCancel();
  }
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  function breadcrumbs(): { label: string; path: string }[] {
    const v = view();
    if (!v) return [];
    const sep = v.path.includes("\\") ? "\\" : "/";
    const parts = v.path.split(sep).filter((p) => p.length > 0);
    const out: { label: string; path: string }[] = [];
    let acc = sep === "/" ? "" : "";
    if (sep === "/") {
      out.push({ label: "/", path: "/" });
      for (const part of parts) {
        acc = `${acc}/${part}`;
        out.push({ label: part, path: acc });
      }
    } else {
      // Windows: first part includes drive letter (e.g. C:).
      if (parts.length > 0) {
        acc = `${parts[0]}\\`;
        out.push({ label: parts[0]!, path: acc });
        for (let i = 1; i < parts.length; i++) {
          acc = `${acc}${parts[i]}\\`;
          out.push({ label: parts[i]!, path: acc.slice(0, -1) });
        }
      }
    }
    return out;
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pick a folder"
      data-testid="folder-picker"
    >
      <div class="absolute inset-0 bg-black/60" onClick={props.onCancel} />
      <div class="relative w-full max-w-2xl rounded-xl border border-border bg-bg-1 shadow-2xl overflow-hidden flex flex-col h-[70vh]">
        <header class="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 class="text-[15px] font-semibold tracking-tight">Choose a folder</h2>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-icon"
            onClick={props.onCancel}
            aria-label="Close"
            data-testid="folder-picker-close"
          >
            <XIcon />
          </button>
        </header>

        {/* Breadcrumb */}
        <div class="px-5 py-2 border-b border-border flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
          <For each={breadcrumbs()}>
            {(c, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="text-fg-subtle">/</span>
                </Show>
                <button
                  type="button"
                  class="text-[12.5px] font-mono text-fg-muted hover:text-fg px-1.5 py-0.5 rounded hover:bg-bg-2"
                  onClick={() => navigate(c.path)}
                >
                  {c.label}
                </button>
              </>
            )}
          </For>
        </div>

        {/* Roots row */}
        <Show when={roots().length > 1}>
          <div class="px-5 py-2 border-b border-border flex items-center gap-1.5 text-[12px]">
            <span class="text-fg-subtle uppercase tracking-wider text-[10.5px]">Roots</span>
            <For each={roots()}>
              {(r) => (
                <button
                  type="button"
                  class="ag-chip hover:bg-bg-3 cursor-pointer"
                  onClick={() => navigate(r)}
                >
                  {r}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Entries */}
        <div class="flex-1 overflow-y-auto px-3 py-2">
          <Show when={view()?.parent}>
            <button
              type="button"
              class="ag-list-item w-full"
              onClick={() => navigate(view()!.parent!)}
              data-testid="folder-picker-up"
            >
              <ArrowUpIcon />
              <span>..</span>
              <span class="ml-auto text-[11px] text-fg-subtle">parent</span>
            </button>
          </Show>

          <Show
            when={!loading() && view()}
            fallback={<p class="text-[12.5px] text-fg-subtle px-3 py-3">Loading…</p>}
          >
            <For
              each={view()!.entries}
              fallback={
                <p class="text-[12.5px] text-fg-subtle px-3 py-3">
                  No subfolders here. You can still select this directory.
                </p>
              }
            >
              {(e) => (
                <button
                  type="button"
                  class="ag-list-item w-full"
                  classList={{ "opacity-50": !e.readable }}
                  disabled={!e.readable}
                  onClick={() => navigate(e.path)}
                  data-testid={`folder-picker-entry-${e.name}`}
                  title={e.path}
                >
                  <FolderIcon />
                  <span class="truncate">{e.name}</span>
                </button>
              )}
            </For>
          </Show>

          <Show when={err()}>
            <p class="text-[12.5px] text-danger px-3 py-2" data-testid="folder-picker-error">
              {err()}
            </p>
          </Show>
        </div>

        {/* Footer */}
        <footer class="px-5 py-3 border-t border-border flex items-center justify-between gap-3">
          <div
            class="text-[12px] font-mono text-fg-muted truncate flex-1"
            title={view()?.path}
            data-testid="folder-picker-current"
          >
            {view()?.path ?? ""}
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="ag-btn ag-btn-ghost"
              onClick={props.onCancel}
              data-testid="folder-picker-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              class="ag-btn ag-btn-primary"
              disabled={!view()}
              onClick={() => view() && props.onSelect(view()!.path)}
              data-testid="folder-picker-select"
            >
              Select this folder
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class="text-fg-subtle"
    >
      <path
        d="M12 19V5m0 0-6 6m6-6 6 6"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class="text-fg-subtle"
    >
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}
