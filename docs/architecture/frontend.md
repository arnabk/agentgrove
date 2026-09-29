# Frontend modules

SolidJS + Vite + Tailwind + Kobalte headless primitives. CodeMirror 6 for
editor and diff. xterm.js for terminal. Tiptap for the chat composer and
the notes scratchpad.

## Stack

- SolidJS 1.x, `@solidjs/router`
- Vite 5
- Tailwind CSS 3
- Kobalte (headless a11y primitives)
- CodeMirror 6 + `@codemirror/merge`
- xterm.js + addons (fit, webgl)
- Tiptap 2 (chat composer, notes)
- Typed API client generated from BE OpenAPI

## Source layout

One app, two form-factor shells, four layers. Dependencies point strictly
inward — see [ADR-0009](../adr/0009-mobile-shell-and-frontend-layering.md).

```
apps/web/src/
  main.tsx              entry: mounts the auth gate, then the shell selector
  shell.tsx             matchMedia -> lazy(desktop) | lazy(mobile)
  styles.css            theme variables + global CSS

  core/                 headless. No JSX layout, no component imports.
    api/                client.ts, types.ts
    stores/             app.ts (scope/projects/tabs/settings), db.ts
    chat/               chatStream.ts — WS frame protocol, shell-agnostic
    lib/                routeSync, crossInstanceSync, crossTabs, memory,
                        memMonitor, toastBus, celestial, notesTodo, …

  ui/                   generic presentational primitives
                        ChatComposer, Markdown, Toast, dialog, Select,
                        MultiSelect, Slider, Logo, MicButton

  features/             domain components shared by both shells
    chat/               ToolRail, NewChatDialog, ChatSettingsDialog,
                        ChatHistoryDialog
    notes/              NotesPane
    settings/           SettingsModal, IntegrationsTab
    projects/           FolderPicker, WorktreeDialog, RenameWorktreeDialog
    teamchat/           TeamChatPane

  shells/
    desktop/            App, LeftRail, TabStrip, RightSidebar, dialogs,
                        panes/ (Chat, Editor, Terminal, Db, Diff)
    mobile/             MobileApp, NavDrawer, TabBar, ChatView, …
```

### The rules

1. `core/` may not import from `ui/`, `features/` or `shells/`.
2. `ui/` may not import from `features/` or `shells/`.
3. `features/` may not import from `shells/`. Pass a prop instead.
4. `shells/desktop/` and `shells/mobile/` may never import each other.
   Promote shared code to `features/` or `ui/`.

These are enforced by `no-restricted-imports` blocks in
`apps/web/eslint.config.js`, matched on the trailing path so both
`@/shells/...` and `../../shells/...` are caught. `pnpm lint` fails on a
violation.

All imports use the `@/*` alias (declared in `tsconfig.json` and
`vite.config.ts`) rather than relative chains.

## Shell selection

`shell.tsx` reads `matchMedia("(max-width: 767px)")` and lazily mounts one
shell or the other. It is reactive, so rotating a tablet or resizing a
window swaps shells; shell state is reconstructed from the store and the
backend, so a swap is safe mid-session.

Overrides, in precedence order:

1. `?ui=mobile` / `?ui=desktop` in the URL — sticky, persisted.
2. `localStorage["ag-ui-shell"]` — set by the in-app "Desktop version" /
   "Mobile version" links.
3. The media query.

Both shells sit *inside* the auth gate in `main.tsx`, so login behaves
identically in either and works with auth on or off.

## Desktop layout

- Left rail: projects / worktrees / database / ClickUp
- Top: unified tab strip (chat, terminal, editor, db)
- Main: active tab pane
- Right sidebar: Notes + Team Chat
- Command palette (Cmd+P), Settings (Cmd+,)

## Mobile layout

A deliberate subset — see ADR-0009 non-goals for what is excluded.

- Hamburger → navigation drawer: projects, worktrees (read-write), chats
- Bottom tab bar: Chats · Team · Notes · Settings
- Full-screen chat thread with the shared Tiptap composer
- Live via the same `/ws?topic=sync` cross-instance channel as desktop, so
  desktop and phone stay in step
- `startMemoryMonitor()` is desktop-only (a debugging tool, not a feature)

## Theming

CSS variables. Built-in themes ship as JSON. The user can import
VSCode-style JSON themes for the editor (CodeMirror highlight styles).
App-wide font scaling is CSS `zoom` on the root element, with
`--ag-zoom-inv` available to cancel it where an element must not scale.

## Targets

- Initial JS gz < 250KB (desktop shell), < 120KB (mobile shell)
- TTI < 1.5s on mid laptop
- 60fps editor scroll, terminal 1MB/s without drop
