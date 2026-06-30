import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Turns the Notes editor's headings into collapsible group toggles.
 *
 * Implemented as a standalone Extension (rather than extending the
 * Heading node, which StarterKit bundles privately): it adds a
 * persisted `collapsed` boolean attribute to the existing `heading`
 * node via `addGlobalAttributes`, plus a ProseMirror plugin that draws
 * the ▸/▾ toggle and hides the folded blocks.
 *
 * Each heading gains a `collapsed` attribute (stored as
 * `data-collapsed="true"` in the saved HTML). A ▸/▾ toggle is drawn in
 * the heading's left gutter via a widget decoration. While a heading is
 * collapsed, every following top-level block is hidden — via a node
 * decoration adding the `ag-collapsed-hidden` class — up to (but not
 * including) the next heading whose level is the same or shallower. So
 * an H2 folds its H3 subsections too, but stops at the next H1/H2.
 *
 * Safety: the document is NEVER mutated to hide content. Only the
 * heading's own `collapsed` attribute is stored; hidden blocks stay in
 * the doc and reappear instantly on expand. Zero risk of losing todos.
 */

const collapseKey = new PluginKey("notesCollapsibleHeading");

export const CollapsibleHeading = Extension.create({
  name: "collapsibleHeading",

  addGlobalAttributes() {
    return [
      {
        types: ["heading"],
        attributes: {
          collapsed: {
            default: false,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-collapsed") === "true",
            renderHTML: (attributes: { collapsed?: boolean }) => {
              // Only emit when collapsed so expanded headings stay clean.
              if (!attributes.collapsed) return {};
              return { "data-collapsed": "true" };
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [collapsiblePlugin()];
  },
});

/** Heading level for a node, or null if it isn't a heading. */
function headingLevel(node: PMNode): number | null {
  return node.type.name === "heading" ? (node.attrs.level as number) : null;
}

/** Build the decoration set: a toggle widget on every heading + a hide
 *  class on blocks under a collapsed one. */
function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  const topLevel: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, offset) => {
    topLevel.push({ node, pos: offset });
  });

  for (let i = 0; i < topLevel.length; i++) {
    const entry = topLevel[i]!;
    const level = headingLevel(entry.node);
    if (level == null) continue;

    const collapsed = entry.node.attrs.collapsed === true;

    decos.push(
      Decoration.widget(entry.pos + 1, () => makeToggle(collapsed), {
        side: -1,
        key: `toggle-${entry.pos}-${collapsed}`,
      }),
    );

    if (!collapsed) continue;

    for (let j = i + 1; j < topLevel.length; j++) {
      const next = topLevel[j]!;
      const nextLevel = headingLevel(next.node);
      if (nextLevel != null && nextLevel <= level) break;
      decos.push(
        Decoration.node(next.pos, next.pos + next.node.nodeSize, {
          class: "ag-collapsed-hidden",
        }),
      );
    }
  }

  return DecorationSet.create(doc, decos);
}

/** The clickable ▸/▾ toggle DOM node for a heading widget. */
function makeToggle(collapsed: boolean): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ag-heading-toggle";
  btn.setAttribute("contenteditable", "false");
  btn.setAttribute("aria-label", collapsed ? "Expand section" : "Collapse section");
  btn.setAttribute("data-collapsed", collapsed ? "true" : "false");
  btn.dataset.headingToggle = "true";
  // Clean chevron SVG (rotated via CSS for the expanded state) instead
  // of a raw ▸ glyph, which rendered chunky and baseline-misaligned.
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" ' +
    'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  return btn;
}

function collapsiblePlugin() {
  return new Plugin({
    key: collapseKey,
    state: {
      init: (_, { doc }) => buildDecorations(doc),
      apply(tr, old) {
        return tr.docChanged ? buildDecorations(tr.doc) : old;
      },
    },
    props: {
      decorations(state) {
        return collapseKey.getState(state);
      },
      handleDOMEvents: {
        mousedown(view: EditorView, event: Event) {
          const target = event.target as HTMLElement | null;
          const toggle = target?.closest?.("[data-heading-toggle]") as HTMLElement | null;
          if (!toggle) return false;
          event.preventDefault();
          event.stopPropagation();
          toggleHeadingAt(view, toggle);
          return true;
        },
      },
    },
  });
}

/** Flip the `collapsed` attribute of the clicked heading. We locate the
 *  heading's document position by matching the clicked <h*> element
 *  against each top-level heading node's DOM (`view.nodeDOM`). This is
 *  more robust than `posAtDOM` on a widget, which can resolve to the
 *  widget rather than the heading. */
function toggleHeadingAt(view: EditorView, toggle: HTMLElement) {
  const headingEl = toggle.closest("h1, h2, h3") as HTMLElement | null;
  if (!headingEl) return;

  const doc = view.state.doc;
  let foundPos: number | null = null;
  let foundNode: PMNode | null = null;
  doc.forEach((node, offset) => {
    if (foundPos != null) return;
    if (node.type.name !== "heading") return;
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (dom === headingEl) {
      foundPos = offset;
      foundNode = node;
    }
  });

  if (foundPos == null || foundNode == null) return;
  const tr = view.state.tr.setNodeAttribute(
    foundPos,
    "collapsed",
    !(foundNode as PMNode).attrs.collapsed,
  );
  view.dispatch(tr);
}
