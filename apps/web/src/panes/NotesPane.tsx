import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import Link from "@tiptap/extension-link";
import GlobalDragHandle from "tiptap-extension-global-drag-handle";
import { Markdown } from "tiptap-markdown";
import { api } from "../api/client";
import { useSyncSubscription } from "../lib/crossInstanceSync";

/**
 * One large workspace-**global** rich-text scratchpad. Persists to the
 * BE at /api/notes with debounced autosave. It is no longer tied to the
 * selected project — switching projects does not change the note.
 * Supports:
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
// Save status is rendered by the parent (RightSidebar) on the "Notes"
// title row, not in this pane's toolbar. Module-level signals let the
// title header subscribe without threading props up through the tree.
export const [notesSavedAt, setNotesSavedAt] = createSignal<string | null>(null);
export const [notesSaving, setNotesSaving] = createSignal(false);
export const [notesErr, setNotesErr] = createSignal<string | null>(null);

export default function NotesPane() {
  let host!: HTMLDivElement;
  let editor: Editor | null = null;
  // True once the global note has been fetched into the editor. Saves
  // are blocked until then so a debounced autosave can't PUT the empty
  // doc that exists during the initial load.
  const [loaded, setLoaded] = createSignal(false);
  const setSavedAt = setNotesSavedAt;
  const setSaving = setNotesSaving;
  // Raw epoch ms of our last successful save. The cross-instance
  // sync echo guard compares against this — the displayed savedAt is a
  // localised display string (e.g. "02:35 PM") that can't be
  // parsed back into a millisecond value reliably.
  let lastSavedMs = 0;
  const setErr = setNotesErr;
  const [linkBarOpen, setLinkBarOpen] = createSignal(false);
  const [linkValue, setLinkValue] = createSignal("https://");
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Data-loss guards. A save must only ever persist content that the
  // user actually edited — never the transient empty doc that exists
  // while the note is still loading.
  //
  //  - loading: true while loadNote is mid-flight; blocks saves so a
  //    load race can't PUT an empty/stale doc.
  //  - loadedBody: the exact HTML we last loaded from (or saved to) the
  //    BE. A save is skipped when the editor still matches this baseline
  //    (nothing changed) so a re-mount never rewrites an untouched doc.
  let loading = false;
  let loadedBody = "";
  // A bare-empty tiptap document. Used to refuse clobbering a non-empty
  // remote with an empty buffer that the user never intentionally
  // produced (e.g. content cleared by a project swap mid-flush).
  const EMPTY_DOC = "<p></p>";

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
        Markdown.configure({
          html: true,
          tightLists: true,
          tightListClass: "tight",
          breaks: false,
          transformPastedText: true,
          transformCopiedText: true,
        }),
        Link.configure({
          openOnClick: true,
          autolink: true,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        }),
        Placeholder.configure({
          placeholder:
            "Start writing… use the toolbar above, markdown shortcuts, or paste markdown directly.",
        }),
        // Block-level drag handle: hovering any paragraph / heading
        // / list-item reveals a `⠿` grab handle in the left gutter
        // (see styles.css `.drag-handle`). Drag it to reorder
        // anywhere in the doc; the underlying ProseMirror node
        // moves as a unit so nested lists + tasks stay intact.
        GlobalDragHandle.configure({
          dragHandleWidth: 24,
          scrollTreshold: 100,
          // Default excludes already cover code blocks / horizontal
          // rules; we add task-list children so dragging a parent
          // task moves the whole subtree instead of orphaning the
          // nested checks.
          excludedTags: [],
        }),
      ],
      editorProps: {
        attributes: {
          class: "ag-prose pl-10 pr-6 py-5 focus:outline-none min-h-full",
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

  // Load the global note once the editor exists. Notes are no longer
  // scoped to a project, so there's nothing to react to — one fetch on
  // mount, plus cross-instance sync reloads below.
  onMount(() => void loadNote());

  async function loadNote() {
    if (!editor) return;
    setErr(null);
    setSavedAt(null);
    // Block saves until the fetched content is in the editor — without
    // this an autosave fired during the load could PUT the empty doc.
    loading = true;
    try {
      const pad = await api.getNotes();
      const newBody = pad.body || "";
      // Remember the loaded baseline so flushSave can tell a genuine
      // edit apart from an untouched doc (and never re-save the latter).
      loadedBody = newBody || EMPTY_DOC;
      // Skip the DOM replacement when the content hasn't changed —
      // a no-op setContent still resets ProseMirror's selection
      // (jumping the cursor to the end on every autosave echo).
      const currentHtml = editor?.getHTML() ?? "";
      if (newBody !== currentHtml) {
        // Preserve the cursor position across the content swap.
        // ProseMirror's setContent blows the selection away; we
        // save the JSON-serialised selection anchor+head, run the
        // replacement, then restore it.
        const anchor = editor?.state.selection.anchor ?? 0;
        const head = editor?.state.selection.head ?? 0;
        editor?.commands.setContent(newBody, false);
        
        // Clamp to the new document length so an out-of-bounds
        // anchor (remote edit shortened the doc) doesn't throw.
        if (editor) {
          const max = editor.state.doc.content.size;
          const safeAnchor = Math.min(anchor, max);
          const safeHead = Math.min(head, max);
          editor.commands.setTextSelection({ from: safeAnchor, to: safeHead });
        }
      }
      editor?.setEditable(true);
      setLoaded(true);
      if (pad.body && pad.updated_at) {
        setSavedAt(formatTime(pad.updated_at));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      loading = false;
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
    if (!loaded() || !editor) return;
    // Never save while the note is still loading — the editor may hold
    // the transient empty doc.
    if (loading) return;
    const html = editor.getHTML();
    // Nothing changed since we loaded/last saved — skip. This stops a
    // re-mount from rewriting an untouched document.
    if (html === loadedBody) return;
    // Refuse to clobber a non-empty remote with an empty buffer UNLESS
    // the user is actively editing (editor focused). A clear that
    // happens while the editor is unfocused is a re-mount race, not an
    // intentional delete — bail out to protect the notes. A focused
    // empty doc is a real "select-all + delete".
    if (html === EMPTY_DOC && loadedBody !== EMPTY_DOC && !editor.isFocused) {
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.saveNotes(html);
      loadedBody = html;
      lastSavedMs = Date.now();
      setSavedAt(formatTime(new Date().toISOString()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Cross-instance sync: another client (any browser, any machine)
  // edited the global note. Reload so we render their changes; suppress
  // our own save echo by comparing against our last save time.
  useSyncSubscription((frame) => {
    if (frame.kind !== "notes_updated") return;
    if (!loaded()) return;
    // If WE just saved (within the last 3 s) the frame is our own echo
    // — skip the reload to avoid clobbering the user's in-flight edits.
    if (lastSavedMs > 0 && Date.now() - lastSavedMs < 3_000) return;
    void loadNote();
  });

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
          <ToolBtn label={<UndoIcon />} title="Undo (⌘Z)" onClick={() => chain()?.undo().run()} />
          <ToolBtn label={<RedoIcon />} title="Redo (⌘⇧Z)" onClick={() => chain()?.redo().run()} />
        </ToolbarGroup>
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
          <button
            type="submit"
            class="ag-btn ag-btn-primary ag-btn-sm"
            data-testid="notes-link-apply"
          >
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
        classList={{ "opacity-50 pointer-events-none": !loaded() }}
      >
        <div ref={(el) => (host = el)} class="min-h-full" />
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
      onClick={() => props.onClick()}
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
