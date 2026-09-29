import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * Theme-aware CodeMirror theme.
 *
 * Uses the same CSS custom properties as the rest of the app so the editor
 * matches the active theme (Solarized, Tokyo Night, light, dark, etc.).
 * Syntax highlighting is intentionally restrained so it stays readable
 * across every palette.
 */
const theme = EditorView.theme(
  {
    "&": {
      color: "var(--ag-fg)",
      backgroundColor: "var(--ag-bg-1)",
    },
    ".cm-content": {
      caretColor: "var(--ag-accent)",
      fontFamily: "var(--ag-font-mono)",
      lineHeight: "1.55",
    },
    ".cm-scroller": { lineHeight: "1.55" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ag-accent)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "var(--ag-accent-soft)",
      },
    ".cm-panels": {
      backgroundColor: "var(--ag-bg-2)",
      color: "var(--ag-fg)",
    },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--ag-border)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--ag-border)" },
    ".cm-searchMatch": {
      backgroundColor: "var(--ag-accent-soft)",
      outline: "1px solid var(--ag-accent)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--ag-accent-soft)",
    },
    ".cm-activeLine": { backgroundColor: "var(--ag-bg-2)" },
    ".cm-selectionMatch": { backgroundColor: "var(--ag-bg-3)" },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "var(--ag-bg-3)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--ag-bg-1)",
      color: "var(--ag-fg-muted)",
      borderRight: "1px solid var(--ag-border)",
    },
    ".cm-activeLineGutter": { backgroundColor: "var(--ag-bg-2)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--ag-fg-muted)",
    },
    ".cm-tooltip": {
      border: "1px solid var(--ag-border-strong)",
      backgroundColor: "var(--ag-bg-2)",
    },
    ".cm-tooltip .cm-tooltip-arrow:before": {
      borderTopColor: "transparent",
      borderBottomColor: "transparent",
    },
    ".cm-tooltip .cm-tooltip-arrow:after": {
      borderTopColor: "var(--ag-bg-2)",
      borderBottomColor: "var(--ag-bg-2)",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: "var(--ag-accent-soft)",
        color: "var(--ag-fg)",
      },
    },
    ".cm-lineNumbers": { color: "var(--ag-fg-muted)" },
    ".cm-foldGutter": { color: "var(--ag-fg-muted)" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--ag-accent)" },
  {
    tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName],
    color: "var(--ag-fg)",
  },
  {
    tag: [tags.function(tags.variableName), tags.labelName],
    color: "var(--ag-accent-hover)",
  },
  {
    tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
    color: "var(--ag-warning)",
  },
  { tag: [tags.definition(tags.name), tags.separator], color: "var(--ag-fg)" },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace,
    ],
    color: "var(--ag-warning)",
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.link,
      tags.special(tags.string),
    ],
    color: "var(--ag-fg-muted)",
  },
  { tag: [tags.meta, tags.comment], color: "var(--ag-fg-subtle)" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--ag-accent)", textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "bold", color: "var(--ag-accent)" },
  {
    tag: [tags.atom, tags.bool, tags.special(tags.variableName)],
    color: "var(--ag-warning)",
  },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: "var(--ag-success)" },
  { tag: tags.invalid, color: "var(--ag-danger)" },
]);

export const editorTheme = [theme, syntaxHighlighting(highlight)];
