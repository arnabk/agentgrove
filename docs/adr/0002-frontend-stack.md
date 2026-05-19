# ADR-0002: Frontend stack

- Status: Accepted
- Date: 2026-05-18

## Context

We want a polished, fast UI with a small bundle and low memory overhead.

## Decision

- SolidJS 1.x + Vite 5.
- Tailwind CSS 3 + Kobalte headless primitives.
- CodeMirror 6 + `@codemirror/merge` for editor and diff view.
- xterm.js + webgl addon for terminal.
- Typed API client generated from BE OpenAPI.

## Rationale

- Solid's fine-grained reactivity gives React-like DX with much smaller
  runtime and faster updates.
- Kobalte gives a11y primitives without imposing design.
- CodeMirror 6 is significantly lighter than Monaco and has first-class
  theming via highlight styles.

## Alternatives considered

- React 19: largest ecosystem but heavier.
- Svelte 5: great DX but smaller a11y primitive ecosystem than Kobalte/Ark.
- Leptos (Rust/WASM): single-language but smaller ecosystem and larger
  initial download for our scope.
