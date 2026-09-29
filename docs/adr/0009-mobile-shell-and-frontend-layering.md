# ADR-0009: Mobile shell and frontend layering

- Status: Accepted
- Date: 2026-09-29

## Context

AgentGrove's UI was built for a desktop window: a resizable left rail, a
tab strip, panes for the editor, terminal, diff and database, and a right
sidebar. `#root` carried `min-width: 1024px`, so a phone rendered the
desktop layout behind a horizontal scrollbar.

We want a genuinely usable phone experience covering a deliberate subset:
project/worktree navigation, AI chat, team chat, notes, and settings. It
must stay light — the desktop entry chunk is ~917 KB raw / ~302 KB gzip,
which is not a phone budget — and it must stay live, because a user moving
between their desk and their phone expects the two views in step.

Two structural options were considered.

### Rejected: a second app under `apps/mobile`

The obvious monorepo move, but wrong here for concrete reasons:

- The Rust binary serves exactly **one** SPA from one port. Two Vite apps
  means two `index.html` documents, so a form-factor change becomes a full
  page navigation and the static handler needs bundle routing.
- The auth gate (`/api/auth/config` → `/api/auth/me`) would run twice, once
  per document.
- Roughly 80% of what mobile needs is already shared: the API client, the
  app store, `routeSync`, `crossInstanceSync`, the Tiptap composer,
  `NotesPane`, `TeamChatPane`, `SettingsModal`. A second app forces a
  `packages/shared` immediately — three packages to maintain instead of one.

`apps/*` is the right home for separate **deployables** (a native app, an
Electron shell, a docs site). A second form factor of the same deployable
is not one of those.

## Decision

One app, two shells, selected at runtime by viewport, with the frontend
source split into four layers:

```
apps/web/src/
  main.tsx                  entry + auth gate
  shell.tsx                 matchMedia -> lazy(desktop) | lazy(mobile)

  core/                     headless. api client, stores, lib, chat stream
  ui/                       generic presentational primitives
  features/                 domain components shared by both shells
  shells/desktop/           the full workspace
  shells/mobile/            the phone subset
```

Dependencies point strictly inward: `shells → features → ui → core`. The
two shells may never import each other.

This is enforced, not documented: `eslint.config.js` carries
`no-restricted-imports` blocks per layer, matched on the trailing path so
both `@/shells/...` and `../../shells/...` are caught. A developer who
reaches across a boundary gets a CI failure with a message telling them
where the code belongs.

Both shells are `lazy()`, so a phone downloads neither the desktop shell
nor its CodeMirror / xterm dependencies.

## Consequences

- **Parallel work is safe.** Two developers in `shells/desktop` and
  `shells/mobile` have essentially no merge surface. Shared change is
  visible as a diff under `core/`, `ui/` or `features/` and reviewed as a
  both-shells change.
- **`core/` stays testable.** The no-UI-imports rule means every store and
  helper is reachable from a plain vitest file with no DOM component tree.
  Splitting the toast queue into `core/lib/toastBus.ts` (headless) and
  `ui/Toast.tsx` (renderer) was the one violation this surfaced.
- **Import paths are absolute.** Everything uses the `@/*` alias that
  `tsconfig.json` and `vite.config.ts` already declared but nothing used.
  Relative `../../..` chains are gone.
- **One more indirection on boot.** `shell.tsx` resolves a media query
  before either shell mounts. It is a synchronous `matchMedia` read, so the
  cost is a lazy-chunk fetch, not a round-trip.
- **A clean exit to `packages/`.** Because `core/` provably imports no UI,
  it lifts out to `packages/core` almost verbatim the day a genuinely
  separate deployable appears.

## Non-goals

- Feature parity. The editor, terminal, diff, database, ClickUp, galaxy
  map, PR/branch/ticket centres, prompt queue and command palette are
  desktop-only by design.
- A native app or an app-store presence. This is the same web app,
  responsive.
- Offline support. The shell still assumes a reachable backend.
