import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { api, type TreeEntry } from "../api/client";
import { selectedFilePath, selectFile, state } from "../stores/app";

/**
 * File explorer column. Renders the selected project's directory tree.
 *
 * Subdirectories load lazily on first expand. All entries are returned
 * (including dotfiles); the BE was updated to honour `show_hidden=true`.
 */
export default function ProjectFiles() {
  const project = createMemo(() =>
    state.projects.find((p) => p.id === state.selectedProjectId) ?? null,
  );

  return (
    <Show when={project()} keyed>
      {(p) => (
        <aside
          class="w-[280px] shrink-0 border-r border-border bg-transparent flex flex-col"
          data-testid="project-files"
        >
          <div class="px-4 h-12 flex items-center justify-between border-b border-border">
            <div class="min-w-0">
              <div class="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
                Files
              </div>
              <div
                class="text-[12.5px] font-mono text-fg-muted truncate"
                title={p.root}
              >
                {p.root}
              </div>
            </div>
          </div>
          <div class="flex-1 overflow-auto px-1 py-2 text-[13px]">
            <DirNode path={p.root} depth={0} initiallyOpen />
          </div>
        </aside>
      )}
    </Show>
  );
}

interface DirNodeProps {
  path: string;
  depth: number;
  initiallyOpen?: boolean;
}

function DirNode(props: DirNodeProps) {
  const [open] = createSignal(props.initiallyOpen ?? false);
  const [entries] = createResource(open, async (isOpen) => {
    if (!isOpen) return [] as TreeEntry[];
    try {
      return await api.listTree(props.path, true);
    } catch {
      return [] as TreeEntry[];
    }
  });

  return (
    <ul class="space-y-px">
      <For each={entries() ?? []}>
        {(entry) => (
          <Show
            when={entry.is_dir}
            fallback={
              <FileRow path={entry.path} name={entry.name} depth={props.depth} />
            }
          >
            <Folder path={entry.path} name={entry.name} depth={props.depth} />
          </Show>
        )}
      </For>
      <Show when={open() && entries.loading}>
        <li
          class="px-2 py-1 text-[11.5px] text-fg-subtle"
          style={{ "padding-left": `${8 + props.depth * 12}px` }}
        >
          loading…
        </li>
      </Show>
    </ul>
  );
}

interface FolderProps {
  path: string;
  name: string;
  depth: number;
}

function Folder(props: FolderProps) {
  const [open, setOpen] = createSignal(false);
  return (
    <li>
      <button
        type="button"
        class="w-full flex items-center gap-1.5 px-2 py-[3px] rounded hover:bg-bg-2 text-fg-muted hover:text-fg cursor-pointer select-none text-left"
        style={{ "padding-left": `${8 + props.depth * 12}px` }}
        onClick={() => setOpen(!open())}
        title={props.path}
        data-testid={`tree-folder-${props.path}`}
      >
        <Chevron open={open()} />
        <FolderIcon open={open()} />
        <span class="truncate">{props.name}</span>
      </button>
      <Show when={open()}>
        <DirNode path={props.path} depth={props.depth + 1} />
      </Show>
    </li>
  );
}

function FileRow(props: { path: string; name: string; depth: number }) {
  const isActive = () => selectedFilePath() === props.path;
  return (
    <li>
      <button
        type="button"
        class="w-full flex items-center gap-1.5 px-2 py-[3px] rounded text-left cursor-pointer select-none"
        classList={{
          "bg-accent-soft text-fg": isActive(),
          "hover:bg-bg-2 text-fg-muted hover:text-fg": !isActive(),
        }}
        style={{ "padding-left": `${20 + props.depth * 12}px` }}
        onClick={() => selectFile(props.path)}
        title={props.path}
        data-testid={`tree-file-${props.path}`}
      >
        <FileIcon />
        <span class="truncate">{props.name}</span>
      </button>
    </li>
  );
}

function Chevron(props: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{
        transform: props.open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
        color: "var(--ag-fg-subtle)",
      }}
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function FolderIcon(props: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class="text-fg-subtle shrink-0"
    >
      <Show
        when={props.open}
        fallback={
          <path
            d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
        }
      >
        <path
          d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5a2 2 0 0 0-2 2v6"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path
          d="M3 19l2-8a1 1 0 0 1 1-1h15l-2 8a1 1 0 0 1-1 1H3Z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </Show>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class="text-fg-subtle shrink-0"
    >
      <path
        d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path d="M14 3v6h6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
    </svg>
  );
}
