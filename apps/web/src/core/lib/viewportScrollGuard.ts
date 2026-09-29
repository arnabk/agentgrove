import { onCleanup } from "solid-js";

/**
 * Pin the document to scroll offset 0.
 *
 * The root element carries a CSS `zoom` (see applySettings in
 * stores/app) to scale the whole UI with the user's font-size setting.
 * Zoom scales `100vh` too, so the app shell renders slightly taller
 * than the real viewport and the document becomes scrollable by a
 * sliver. ProseMirror's `scrollIntoView` — fired on paste, formatting
 * and selection changes in the notes editor and the chat composer —
 * finds that sliver and scrolls the *document*, which drags the app
 * chrome off-screen. On mobile that means the header disappears.
 *
 * Safe because the app fills the viewport: every internal scroll area
 * uses `overflow: auto` on its own container, so nothing legitimately
 * scrolls the document.
 *
 * Both shells install this. Pair it with a root height of
 * `calc(100dvh * var(--ag-zoom-inv, 1))` so the shell is exactly one
 * viewport tall after scaling.
 */
export function installViewportScrollGuard() {
  const onScroll = () => {
    if (window.scrollY > 0) window.scrollTo(0, 0);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onCleanup(() => window.removeEventListener("scroll", onScroll));
}
