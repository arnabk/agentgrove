import { Match, Show, Switch, createEffect, lazy, onCleanup } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { createShellSelector } from "@/core/lib/shellSelect";

// Both shells are code-split so a phone downloads neither the desktop
// shell nor its CodeMirror / xterm dependencies, and a laptop never
// pays for the mobile shell.
const DesktopApp = lazy(() => import("@/shells/desktop/App"));
const MobileApp = lazy(() => import("@/shells/mobile/MobileApp"));

/**
 * Picks the form-factor shell and mounts exactly one of them.
 *
 * Both shells live inside the auth gate (see main.tsx), so login
 * behaves identically in either and works with auth on or off. Both are
 * also wrapped in the same `Router` with the same catch-all route, so
 * the URL shape (`/p/:pid/w/:wid?pane=&chat=&file=`) is shared and a
 * link opens the same scope on either form factor.
 */
export default function Shell() {
  const shell = createShellSelector();

  // Expose the active shell to CSS. The desktop layout needs its
  // 1024px floor (it would collapse below that); mobile must not have
  // one or a phone renders behind a horizontal scrollbar.
  createEffect(() => {
    const root = document.getElementById("root");
    if (root) root.dataset.shell = shell();
  });
  onCleanup(() => {
    const root = document.getElementById("root");
    if (root) delete root.dataset.shell;
  });

  return (
    <Show when={shell()} keyed>
      {(kind) => (
        <Router>
          <Route
            path="*"
            component={() => (
              <Switch>
                <Match when={kind === "mobile"}>
                  <MobileApp />
                </Match>
                <Match when={kind === "desktop"}>
                  <DesktopApp />
                </Match>
              </Switch>
            )}
          />
        </Router>
      )}
    </Show>
  );
}
