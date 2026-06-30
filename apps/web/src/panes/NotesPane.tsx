import { createSignal, onCleanup, onMount } from "solid-js";
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
import { listsToTaskLists, countTasks, emptyTodoDoc } from "../lib/notesTodo";

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

// Done-section state lives at module scope so the Notes title row in
// RightSidebar can render the "Show/Hide done" toggle while the editor
// (which owns the actual visibility CSS + task tallies) drives the
// numbers. `showDone` = completed todos are currently revealed.
// Default false → completed todos are hidden out of the box.
export const [showDone, setShowDone] = createSignal(false);
export const [notesTaskCounts, setNotesTaskCounts] = createSignal<{
  total: number;
  done: number;
}>({ total: 0, done: 0 });

/** Imperative editor controls exposed to the Notes title row (which
 *  lives in RightSidebar, outside this component). Set when the editor
 *  mounts, cleared on unmount. All formatting buttons — Todo, headings,
 *  undo/redo — call through here so there's a single owner of the
 *  ProseMirror instance. `version` bumps on every transaction so the
 *  title row's active-state highlights re-render reactively. */
export interface NotesActions {
  toggleTask: () => void;
  toggleHeading: (level: 1 | 2 | 3) => void;
  undo: () => void;
  redo: () => void;
  isActive: (name: string, opts?: Record<string, unknown>) => boolean;
}
export const [notesActions, setNotesActions] = createSignal<NotesActions | null>(null);
// Bumped on every editor transaction so reactive consumers (the title
// row toolbar) recompute `isActive(...)` highlights.
export const [notesSelVersion, setNotesSelVersion] = createSignal(0);

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
  // Done-section visibility + task tallies are module-level (declared
  // above) so the title row in RightSidebar can render the toggle.
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
          placeholder: "Add a todo… press Enter for the next one.",
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
      onUpdate: () => {
        scheduleSave();
        recomputeCounts();
        setNotesSelVersion((v) => v + 1);
      },
      onSelectionUpdate: () => setNotesSelVersion((v) => v + 1),
    });

    // Publish the editor's controls so the Notes title row (rendered in
    // RightSidebar) can drive formatting without owning the instance.
    setNotesActions({
      toggleTask: () => editor?.chain().focus().toggleTaskList().run(),
      toggleHeading: (level) => editor?.chain().focus().toggleHeading({ level }).run(),
      undo: () => editor?.chain().focus().undo().run(),
      redo: () => editor?.chain().focus().redo().run(),
      isActive: (name, opts) => Boolean(editor?.isActive(name, opts)),
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
    setNotesActions(null);
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
      const rawBody = pad.body || "";
      // Todo-first transform: convert any plain bullet/numbered lists
      // the user already had into unchecked task lists. Headings and
      // paragraphs are preserved; existing task lists are untouched.
      // Idempotent + unit-tested (see notesTodo.test.ts) so it can't
      // silently mangle content. An empty doc is seeded with one blank
      // todo so the first keystroke is a checklist item.
      const newBody = rawBody ? listsToTaskLists(rawBody) : emptyTodoDoc();
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
      // Re-baseline against the editor's NORMALISED html. Tiptap
      // reformats markup on parse, and our list→todo transform changes
      // the stored html, so `newBody` won't byte-match what the editor
      // now holds. Capturing the normalised form here means the load
      // itself never triggers an autosave — the converted document is
      // only persisted once the user actually edits something. This
      // keeps the conversion non-destructive until the user opts in by
      // touching the note.
      loadedBody = editor?.getHTML() ?? loadedBody;
      editor?.setEditable(true);
      setLoaded(true);
      recomputeCounts();
      if (pad.body && pad.updated_at) {
        setSavedAt(formatTime(pad.updated_at));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      loading = false;
    }
  }

  /** Recompute the total/done task tallies from the live editor so the
   *  "Done (N)" toggle + empty hint stay in sync after every edit. */
  function recomputeCounts() {
    if (!editor) return;
    setNotesTaskCounts(countTasks(editor.getHTML()));
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

  return (
    <section data-testid="notes-pane" class="flex flex-col h-full">
      {/* Editor host. The `notes-hide-done` class hides checked todos
          from the main view (the "close out" behaviour); toggling the
          Done button removes it so completed items reappear in place.
          Visibility only — the document is never mutated, so a checked
          item is one un-click away from coming back. */}
      <div
        class="flex-1 overflow-auto bg-bg-1"
        data-testid="notes-host"
        classList={{
          "opacity-50 pointer-events-none": !loaded(),
          "notes-hide-done": !showDone(),
        }}
      >
        <div ref={(el) => (host = el)} class="min-h-full" />
      </div>
    </section>
  );
}

export function NotesDivider() {
  return <div class="w-px h-5 bg-border" />;
}

export function NotesToolBtn(props: {
  label: import("solid-js").JSX.Element;
  title: string;
  active?: boolean | undefined;
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

export function HeadingIcon(props: { level: 1 | 2 | 3 }) {
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

export function CheckCircleIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

export function TaskListIcon() {
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

export function UndoIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 1 3 7.5" />
    </svg>
  );
}

export function RedoIcon() {
  return (
    <svg {...SVG_DEFAULTS}>
      <path d="M21 7v6h-6" />
      <path d="M21 13a9 9 0 1 0-3 7.5" />
    </svg>
  );
}
