import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import Link from "@tiptap/extension-link";
import { api } from "../api/client";
import { state } from "../stores/app";

/**
 * One large rich-text scratchpad per project. Persists to the BE at
 * /api/projects/:id/scratchpad with debounced autosave. Supports:
 *
 *   - Headings (H1, H2, H3)
 *   - Bullet + ordered lists
 *   - Task list (checkboxes)
 *   - Bold, italic, strikethrough, inline code
 *   - Code block, blockquote
 *   - Link
 *   - Undo / redo
 *
 * Switching projects swaps the document; the unsaved buffer for the
 * previous project flushes before the swap.
 */
export default function NotesPane() {
  let host!: HTMLDivElement;
  let editor: Editor | null = null;
  const [loadedFor, setLoadedFor] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [linkBarOpen, setLinkBarOpen] = createSignal(false);
  const [linkValue, setLinkValue] = createSignal("https://");
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    editor = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Typography,
        Link.configure({
          openOnClick: true,
          autolink: true,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        }),
        Placeholder.configure({
          placeholder:
            "Start writing… use the toolbar above or markdown shortcuts like # H1, ## H2, - bullet, 1. list, [ ] task.",
        }),
      ],
      editorProps: {
        attributes: {
          class: "ag-prose px-6 py-5 focus:outline-none min-h-full",
          spellcheck: "true",
        },
      },
      onUpdate: () => scheduleSave(),
    });
  });

  // Save on tab/window blur so unsaved work isn't lost when the user
  // switches away. Also runs when the document is hidden (e.g. tab change).
  const onBlur = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void flushSave();
  };
  onMount(() => {
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
  });

  onCleanup(() => {
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onBlur);
    if (saveTimer) {
      clearTimeout(saveTimer);
      // Best-effort final flush.
      void flushSave();
    }
    editor?.destroy();
    editor = null;
  });

  // React to project changes.
  createEffect(() => {
    const pid = state.selectedProjectId;
    if (!editor) return;
    if (loadedFor() === pid) return;
    // Flush the previous project's pending write before swapping.
    void flushSave().then(() => loadForProject(pid));
  });

  async function loadForProject(pid: string | null) {
    setErr(null);
    setSavedAt(null);
    if (!pid) {
      editor?.commands.clearContent(false);
      editor?.setEditable(false);
      setLoadedFor(null);
      return;
    }
    try {
      const pad = await api.getScratchpad(pid);
      editor?.commands.setContent(pad.body || "", false);
      editor?.setEditable(true);
      setLoadedFor(pid);
      if (pad.body && pad.updated_at) {
        setSavedAt(formatTime(pad.updated_at));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushSave();
    }, 600);
  }

  async function flushSave() {
    const pid = loadedFor();
    if (!pid || !editor) return;
    setSaving(true);
    setErr(null);
    try {
      const html = editor.getHTML();
      await api.saveScratchpad(pid, html);
      setSavedAt(formatTime(new Date().toISOString()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // ---- toolbar actions ----
  function chain() {
    return editor?.chain().focus();
  }
  const isActive = (name: string, opts?: Record<string, unknown>) =>
    Boolean(editor?.isActive(name, opts));

  return (
    <section data-testid="notes-pane" class="flex flex-col h-full">
      <header class="px-3 py-2 border-b border-border bg-bg-1 flex items-center gap-1 flex-wrap">
        <ToolbarGroup>
          <ToolBtn
            label={<HeadingIcon level={1} />}
            title="Heading 1"
            active={isActive("heading", { level: 1 })}
            onClick={() => chain()?.toggleHeading({ level: 1 }).run()}
          />
          <ToolBtn
            label={<HeadingIcon level={2} />}
            title="Heading 2"
            active={isActive("heading", { level: 2 })}
            onClick={() => chain()?.toggleHeading({ level: 2 }).run()}
          />
          <ToolBtn
            label={<HeadingIcon level={3} />}
            title="Heading 3"
            active={isActive("heading", { level: 3 })}
            onClick={() => chain()?.toggleHeading({ level: 3 }).run()}
          />
        </ToolbarGroup>
        <Divider />
        <ToolbarGroup>
          <ToolBtn
            label={<BoldIcon />}
            title="Bold (⌘B)"
            active={isActive("bold")}
            onClick={() => chain()?.toggleBold().run()}
          />
          <ToolBtn
            label={<ItalicIcon />}
            title="Italic (⌘I)"
            active={isActive("italic")}
            onClick={() => chain()?.toggleItalic().run()}
          />
          <ToolBtn
            label={<StrikeIcon />}
            title="Strikethrough"
            active={isActive("strike")}
            onClick={() => chain()?.toggleStrike().run()}
          />
          <ToolBtn
            label={<CodeInlineIcon />}
            title="Inline code"
            active={isActive("code")}
            onClick={() => chain()?.toggleCode().run()}
          />
        </ToolbarGroup>
        <Divider />
        <ToolbarGroup>
          <ToolBtn
            label={<BulletListIcon />}
            title="Bullet list"
            active={isActive("bulletList")}
            onClick={() => chain()?.toggleBulletList().run()}
          />
          <ToolBtn
            label={<NumberedListIcon />}
            title="Numbered list"
            active={isActive("orderedList")}
            onClick={() => chain()?.toggleOrderedList().run()}
          />
          <ToolBtn
            label={<TaskListIcon />}
            title="Task list (checkboxes)"
            active={isActive("taskList")}
            onClick={() => chain()?.toggleTaskList().run()}
          />
        </ToolbarGroup>
        <Divider />
        <ToolbarGroup>
          <ToolBtn
            label={<QuoteIcon />}
            title="Blockquote"
            active={isActive("blockquote")}
            onClick={() => chain()?.toggleBlockquote().run()}
          />
          <ToolBtn
            label={<CodeBlockIcon />}
            title="Code block"
            active={isActive("codeBlock")}
            onClick={() => chain()?.toggleCodeBlock().run()}
          />
          <ToolBtn
            label={<LinkIcon />}
            title="Add/remove link"
            active={isActive("link")}
            onClick={() => {
              if (!editor) return;
              if (editor.isActive("link")) {
                chain()?.unsetLink().run();
                return;
              }
              setLinkValue("https://");
              setLinkBarOpen(true);
            }}
          />
        </ToolbarGroup>
        <Divider />
        <ToolbarGroup>
          <ToolBtn
            label={<UndoIcon />}
            title="Undo (⌘Z)"
            onClick={() => chain()?.undo().run()}
          />
          <ToolBtn
            label={<RedoIcon />}
            title="Redo (⌘⇧Z)"
            onClick={() => chain()?.redo().run()}
          />
        </ToolbarGroup>

        <div class="ml-auto flex items-center gap-2 text-[11px] text-fg-subtle">
          <Show when={saving()}>
            <span data-testid="notes-saving">saving…</span>
          </Show>
          <Show when={!saving() && savedAt()}>
            <span class="ag-chip ag-chip-success" data-testid="notes-saved-at">
              saved {savedAt()}
            </span>
          </Show>
          <Show when={err()}>
            <span class="text-danger" data-testid="notes-error" title={err() ?? ""}>
              save failed
            </span>
          </Show>
        </div>
      </header>

      <Show when={linkBarOpen()}>
        <form
          class="px-3 py-2 border-b border-border bg-bg-2 flex items-center gap-2"
          data-testid="notes-link-bar"
          onSubmit={(e) => {
            e.preventDefault();
            const url = linkValue().trim();
            if (url && editor) {
              chain()?.extendMarkRange("link").setLink({ href: url }).run();
            }
            setLinkBarOpen(false);
          }}
        >
          <input
            class="ag-input !py-1 !text-[12.5px] font-mono"
            value={linkValue()}
            onInput={(e) => setLinkValue(e.currentTarget.value)}
            placeholder="https://example.com"
            autofocus
            data-testid="notes-link-input"
          />
          <button type="submit" class="ag-btn ag-btn-primary ag-btn-sm" data-testid="notes-link-apply">
            Apply
          </button>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-sm"
            onClick={() => setLinkBarOpen(false)}
            data-testid="notes-link-cancel"
          >
            Cancel
          </button>
        </form>
      </Show>

      <div
        class="flex-1 overflow-auto bg-bg-1"
        data-testid="notes-host"
        classList={{ "opacity-50 pointer-events-none": !state.selectedProjectId }}
      >
        <div ref={(el) => (host = el)} class="h-full" />
      </div>
    </section>
  );
}

function ToolbarGroup(props: { children: import("solid-js").JSX.Element }) {
  return <div class="flex items-center gap-0.5">{props.children}</div>;
}

function Divider() {
  return <div class="w-px h-5 bg-border" />;
}

function ToolBtn(props: {
  label: import("solid-js").JSX.Element;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="inline-flex items-center justify-center w-7 h-7 rounded-md text-fg-muted hover:text-fg hover:bg-bg-2 transition-colors"
      classList={{ "!bg-bg-3 !text-fg": !!props.active }}
      title={props.title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
      data-testid={`notes-tool-${props.title.replace(/\W+/g, "-").toLowerCase()}`}
    >
      {props.label}
    </button>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/* ---------- Toolbar icons (Lucide-style, 16px stroke) ---------------- */

const SVG_DEFAULTS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.7",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  "aria-hidden": true,
} as const;

function HeadingIcon(props: { level: 1 | 2 | 3 }) {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M6 4v16M14 4v16M6 12h8" />
      <text
        x="16.5"
        y="20"
        fill="currentColor"
        stroke="none"
        font-size="9"
        font-weight="700"
        font-family="ui-sans-serif, system-ui, sans-serif"
      >
        {props.level}
      </text>
    </svg>
  );
}

function BoldIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M7 4h6.5a3.5 3.5 0 0 1 0 7H7zM7 11h7a3.5 3.5 0 0 1 0 7H7z" />
    </svg>
  );
}

function ItalicIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M14 4h-4M14 20h-4M15 4l-6 16" />
    </svg>
  );
}

function StrikeIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 1 7.8 11 11 0 0 1-9-.2M4 12h16" />
    </svg>
  );
}

function CodeInlineIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M8 6 2 12l6 6M16 6l6 6-6 6" />
    </svg>
  );
}

function BulletListIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function NumberedListIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M10 6h11M10 12h11M10 18h11" />
      <text
        x="2"
        y="8"
        fill="currentColor"
        stroke="none"
        font-size="7"
        font-weight="600"
        font-family="ui-sans-serif, system-ui, sans-serif"
      >
        1
      </text>
      <text
        x="2"
        y="14"
        fill="currentColor"
        stroke="none"
        font-size="7"
        font-weight="600"
        font-family="ui-sans-serif, system-ui, sans-serif"
      >
        2
      </text>
      <text
        x="2"
        y="20"
        fill="currentColor"
        stroke="none"
        font-size="7"
        font-weight="600"
        font-family="ui-sans-serif, system-ui, sans-serif"
      >
        3
      </text>
    </svg>
  );
}

function TaskListIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M11 6h10M11 12h10M11 18h10" />
      <rect x="2.5" y="3.5" width="6" height="6" rx="3" />
      <rect x="2.5" y="9.5" width="6" height="6" rx="3" />
      <path d="M4 12.5l1.5 1.5L7 11" />
      <rect x="2.5" y="15.5" width="6" height="6" rx="3" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M4 7c0-1.7 1.3-3 3-3M4 11c0-1.7 1.3-3 3-3M4 7v8h4V7M14 7c0-1.7 1.3-3 3-3M14 11c0-1.7 1.3-3 3-3M14 7v8h4V7" />
    </svg>
  );
}

function CodeBlockIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 1 3 7.5" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M21 7v6h-6" />
      <path d="M21 13a9 9 0 1 0-3 7.5" />
    </svg>
  );
}
