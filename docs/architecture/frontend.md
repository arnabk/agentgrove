# Frontend modules

SolidJS + Vite + Tailwind + Kobalte headless primitives. CodeMirror 6 for
editor and diff. xterm.js for terminal.

## Stack

- SolidJS 1.x, `@solidjs/router`
- Vite 5
- Tailwind CSS 3
- Kobalte (headless a11y primitives)
- CodeMirror 6 + `@codemirror/merge`
- xterm.js + addons (fit, webgl)
- Typed API client generated from BE OpenAPI

## Layout

- Left rail: projects / worktrees / chats
- Main grid: Editor | Diff | Terminal | Chat (configurable)
- Bottom: Queue + Notes + Timeline
- Command palette: keyboard-first

## Theming

CSS variables. Built-in themes ship as JSON. User can import VSCode-style
JSON themes for the editor (CodeMirror highlight styles).

## Targets

- Initial JS gz < 250KB
- TTI < 1.5s on mid laptop
- 60fps editor scroll, terminal 1MB/s without drop
