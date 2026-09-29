import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import { Markdown } from "tiptap-markdown";

/**
 * Rich-text chat composer.
 *
 * Wraps a Tiptap editor so the user gets visual markdown rendering as
 * they type (bullet points appear as bullets, `#` headings render as
 * headings, `**bold**` italicises, fenced code blocks indent in
 * monospace) while AgentGrove still ships a plain Markdown string to
 * the agent CLI / 9router (which can't parse our DOM).
 *
 * ## Contract with the parent (`ChatPane`)
 *
 * The parent passes `value` (Markdown string) and `onChange(md)`; the
 * composer maintains its own internal ProseMirror state and only
 * (de)serialises on these boundary events. The `controls` ref hands
 * back imperative methods the existing slash-menu / prompt-picker /
 * file-paths-append flows depend on — these used to poke directly at
 * the textarea's `selectionStart` / `value` and need an equivalent
 * surface now.
 *
 * ## Why tiptap-markdown
 *
 * Out of the box Tiptap stores HTML. Sending HTML to Claude / opencode
 * would force the model to mentally parse a tag soup; sending Markdown
 * gives it the same shape it would get from a CLI prompt today.
 * `tiptap-markdown` provides bidirectional MD ⇄ ProseMirror conversion
 * via its `Markdown` extension, including the keyboard-shortcut
 * autoformatters (`- ` becomes a bullet list, `1. ` an ordered list,
 * etc.) that we promised the user.
 *
 * ## Slash menu integration
 *
 * The parent passes raw signals (query, suggestions, activeIdx) plus
 * handlers; we surface the editor's `editor-host` DOM node and a
 * `selectionRect()` getter so the parent can position the menu above
 * the caret. We also forward key events: when the menu is open, the
 * editor handles its own arrow keys / Enter / Tab / Escape via the
 * `onKey` prop so the parent's existing flow keeps working unchanged.
 */

/** Imperative handle exposed via the `ref` prop. */
export interface ChatComposerHandle {
  /** Move focus to the editor + bring up the OS keyboard on mobile. */
  focus: () => void;
  /** Insert `text` at the current cursor (or replace selection).
   *  Text is treated as Markdown and converted to the corresponding
   *  rich-text nodes so the cursor lands AFTER the rendered output. */
  insertAtCursor: (text: string) => void;
  /** Append a Markdown block at the very end of the document with a
   *  blank line separator. Used for the "Attached files (absolute
   *  paths …)" block produced by file uploads. */
  appendBlock: (markdown: string) => void;
  /** Drop the entire document and rebuild from the supplied Markdown
   *  string. Used when the parent clears the input on submit. */
  setMarkdown: (markdown: string) => void;
  /** Current document serialised as Markdown. */
  getMarkdown: () => string;
  /** Live caret + selection position relative to the viewport. Used
   *  by the parent to anchor the slash menu. Returns `null` when the
   *  editor isn't focused or the selection is collapsed off-screen. */
  selectionRect: () => DOMRect | null;
}

interface Props {
  /** Initial / controlled Markdown value. */
  value: string;
  /** Fired on every doc change with the serialised Markdown. */
  onChange: (markdown: string) => void;
  /** Fired when the user requests submit: plain Enter (no Shift),
   *  matching the old textarea's behaviour. The parent decides
   *  whether to actually send (e.g. ignore when the slash menu is
   *  taking the key). */
  onSubmit: () => void;
  /** Fired when the user pastes files (image paste, file paste). The
   *  parent uploads them and appends an attachment block via
   *  `appendBlock`. */
  onPasteFiles: (files: File[]) => void;
  /** Forwarded keydown so the parent can handle the slash-menu
   *  navigation (ArrowUp/Down/Enter/Tab/Escape) before we apply our
   *  Tiptap defaults. Return `true` to indicate the parent
   *  consumed the event. */
  onKey: (e: KeyboardEvent) => boolean;
  /** Placeholder shown when the doc is empty. */
  placeholder?: string;
  /** Disables editing (used while no chat is selected). */
  disabled?: boolean;
  /** Imperative handle. Solid pattern: parent passes a setter. */
  ref?: (handle: ChatComposerHandle) => void;
  /** Forwarded so tests can still find the input. */
  testId?: string;
}

export default function ChatComposer(props: Props) {
  let host!: HTMLDivElement;
  let editor: Editor | null = null;
  // `editorReady` is a reactive trigger the sync-from-parent
  // effect (line ~276) tracks. Without it the effect's early-exit
  // (`if (!editor) return`) ran once on mount, saw `editor === null`,
  // and never re-ran — so an initial `props.value` set BEFORE the
  // editor finished mounting (the common page-reload case where
  // the parent has hydrated a draft from the BE layout) silently
  // vanished. Flipping this signal in onMount forces the effect
  // to re-run with a live editor.
  const [editorReady, setEditorReady] = createSignal(false);
  // Re-entrancy guard: setMarkdown via `editor.commands.setContent`
  // fires `onUpdate` which would loop back into onChange. We skip
  // the callback while this flag is set.
  let suppressChange = false;
  const [empty, setEmpty] = createSignal(true);

  onMount(() => {
    editor = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({
          // Keep heading levels modest — chat prompts rarely need H4+.
          heading: { levels: [1, 2, 3] },
          // Disable Tiptap's bare-text codeBlock keyboard shortcut so
          // our `onKey` hook can stay in control of the Tab key
          // (StarterKit otherwise eats Tab inside code blocks).
        }),
        Typography,
        Markdown.configure({
          // Render ProseMirror node tree as CommonMark + GFM (lists,
          // fenced code, etc.). The two flags below give us the
          // "type `- ` to start a list" behaviour the user asked
          // about.
          html: false,
          tightLists: true,
          tightListClass: "tight",
          breaks: false,
          transformPastedText: true,
          transformCopiedText: true,
        }),
        Placeholder.configure({
          placeholder: props.placeholder ?? "",
        }),
      ],
      content: props.value || "",
      editorProps: {
        attributes: {
          // Reuse the chat-tuned prose styles + tighten the default
          // padding so the composer feels like the old textarea.
          class:
            "ag-prose ag-prose-chat focus:outline-none min-h-[3.2em] max-h-60 overflow-y-auto px-3 pt-2.5 pb-1",
          spellcheck: "true",
          "data-testid": props.testId ?? "chat-input",
        },
        handlePaste: (_view, event) => {
          // Capture file paste (image paste etc.). Plain-text paste
          // and rich-text paste fall through to Tiptap (so users can
          // paste a markdown snippet from elsewhere and have it
          // render).
          const items = event.clipboardData?.items;
          if (!items) return false;
          const files: File[] = [];
          for (const it of items) {
            if (it.kind === "file") {
              const f = it.getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length > 0) {
            event.preventDefault();
            props.onPasteFiles(files);
            return true;
          }
          // Some browsers (Chrome) expose screenshots as HTML content
          // with an embedded `<img>` tag that has a `file://` src, not
          // as a file item. If we don't catch this, the image silently
          // drops. Read the HTML, extract any data-URI / blob-URI img
          // and upload them.
          const html = event.clipboardData?.getData("text/html");
          if (html) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");
            const imgs = Array.from(doc.querySelectorAll("img[src^='file:'], img[src^='data:']"));
            const dataUrls = imgs
              .map((img) => img.getAttribute("src"))
              .filter((s): s is string => !!s);
            if (dataUrls.length > 0) {
              event.preventDefault();
              // Try fetching each data: URI and converting to a File.
              const futs = dataUrls.map(async (url, i) => {
                const res = await fetch(url);
                const blob = await res.blob();
                const ext = blob.type.split("/").pop() || "png";
                return new File([blob], `pasted-image-${Date.now()}-${i}.${ext}`, {
                  type: blob.type,
                });
              });
              Promise.all(futs)
                .then((converted) => props.onPasteFiles(converted))
                .catch(() => {});
              return true;
            }
          }
          return false;
        },
        handleKeyDown: (_view, event) => {
          // Give the parent a chance to handle the slash menu first.
          if (props.onKey(event)) return true;
          // Cmd/Ctrl+Enter: hard submit regardless of context. The
          // user explicitly opted into "send now" so we don't let
          // list/code-block continuation override it. macOS uses
          // `metaKey`; other platforms use `ctrlKey`.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
            event.preventDefault();
            props.onSubmit();
            return true;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            // Inside a list / blockquote / code-block we want
            // Tiptap's default Enter behaviour (continue the list).
            // Tiptap returns `false` from its Enter command when
            // nothing was consumed — but the cheapest check is to
            // ask the editor whether it's currently in any of those
            // structures.
            const inList =
              editor?.isActive("bulletList") ||
              editor?.isActive("orderedList") ||
              editor?.isActive("taskList") ||
              editor?.isActive("blockquote") ||
              editor?.isActive("codeBlock");
            if (!inList) {
              event.preventDefault();
              props.onSubmit();
              return true;
            }
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        if (suppressChange) return;
        const md = (ed.storage.markdown.getMarkdown() as string) ?? "";
        setEmpty(ed.isEmpty);
        props.onChange(md);
      },
    });
    setEmpty(editor.isEmpty);
    setEditorReady(true);
    props.ref?.({
      focus: () => editor?.commands.focus(),
      insertAtCursor: (text) => {
        if (!editor) return;
        // `insertContent` will parse Markdown when the input looks
        // like rich syntax; for `/cmd` style insertions it stays
        // inline. We mark Markdown via the second arg so headings /
        // lists in inserted templates also render.
        editor.chain().focus().insertContent(text).run();
      },
      appendBlock: (markdown) => {
        if (!editor) return;
        // Move the cursor to the document end and insert a blank
        // line + the block. We use the markdown extension's
        // `setMarkdown` indirectly via insertContent so paragraph /
        // list structure is preserved.
        const end = editor.state.doc.content.size;
        editor.chain().focus().setTextSelection(end).run();
        // If the doc isn't empty, separate with a blank line.
        const sep = editor.isEmpty ? "" : "\n\n";
        editor
          .chain()
          .focus()
          .insertContent(sep + markdown)
          .run();
      },
      setMarkdown: (markdown) => {
        if (!editor) return;
        suppressChange = true;
        editor.commands.setContent(markdown || "", false);
        setEmpty(editor.isEmpty);
        suppressChange = false;
      },
      getMarkdown: () => (editor?.storage.markdown.getMarkdown() as string) ?? "",
      selectionRect: () => {
        if (!editor) return null;
        const { from } = editor.state.selection;
        try {
          const coords = editor.view.coordsAtPos(from);
          // ProseMirror returns viewport-relative top/bottom/left/right
          // numbers; wrap them in a DOMRect-shaped object so the
          // parent's positioning code (which expects
          // getBoundingClientRect()-style data) can reuse the same
          // math.
          return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
        } catch {
          return null;
        }
      },
    });
  });

  // Keep the editor in sync when the parent rewrites the value
  // (e.g. clears on submit, or hydrates a draft from the BE layout
  // after a page reload). We track `editorReady` so the effect
  // re-runs once the editor finishes mounting; without this an
  // initial `props.value` set before onMount would never reach the
  // editor and the composer would render empty even though the
  // parent has the right value.
  createEffect(() => {
    const incoming = props.value;
    const ready = editorReady();
    if (!ready || !editor) return;
    const current = (editor.storage.markdown.getMarkdown() as string) ?? "";
    if (incoming === current) return;
    suppressChange = true;
    editor.commands.setContent(incoming || "", false);
    setEmpty(editor.isEmpty);
    suppressChange = false;
  });

  // Toggle editability on disabled-prop change.
  createEffect(() => {
    editor?.setEditable(!props.disabled);
  });

  onCleanup(() => {
    editor?.destroy();
    editor = null;
  });

  return (
    <div
      ref={(el) => (host = el)}
      class="ag-composer w-full"
      classList={{ "opacity-60 pointer-events-none": Boolean(props.disabled) }}
      data-empty={empty()}
    />
  );
}
