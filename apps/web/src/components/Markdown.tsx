import { createMemo } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Streaming-friendly markdown renderer.
 *
 * The chat surface receives partial token text and re-renders on every
 * delta, so this component:
 *
 * - parses with `marked` (GFM enabled, breaks on single newlines so
 *   in-progress lists / code fences look right even when partially
 *   typed),
 * - sanitizes the result with DOMPurify before injecting via
 *   `innerHTML` (defence in depth: model output is locally produced
 *   but tool results can echo back user-supplied URLs / HTML),
 * - leaves layout to the `.ag-prose` styles in styles.css so all
 *   chat bubbles inherit the same typography knobs.
 *
 * Trade-offs:
 *   - We do NOT run client-side syntax highlighting here. Code blocks
 *     get a plain monospace `<pre><code>` and the styles render them
 *     inside the bubble; a future commit can hook a lightweight
 *     highlighter behind the same component if needed.
 *   - `marked` re-parses the full text on every keystroke. For chat
 *     replies this is fine (≤ a few KB), but if we ever feed
 *     gigabyte transcripts we should switch to an incremental
 *     parser.
 */

// Configure once at module load. Equivalent to marked.setOptions.
marked.use({
  gfm: true,
  breaks: true,
});

interface Props {
  /** Raw markdown source. Empty string renders nothing. */
  source: string;
  /** Optional class added to the rendered wrapper. */
  class?: string;
}

export default function Markdown(props: Props) {
  const html = createMemo(() => {
    const src = props.source ?? "";
    if (!src) return "";
    // `marked` returns string|Promise — disable async via the default
    // sync config to keep the render simple.
    const raw = marked.parse(src, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target", "rel"],
    });
  });

  return (
    <div
      // eslint-disable-next-line solid/no-innerhtml
      class={`ag-prose ${props.class ?? ""}`}
      innerHTML={html()}
    />
  );
}
