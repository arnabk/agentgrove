import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { Match, Show, Switch, createResource } from "solid-js";
import App from "@/shells/desktop/App";
import ToastHost from "@/ui/Toast";
import { applyCachedZoom } from "@/core/stores/app";
import { api, setAuthEnabled } from "@/core/api/client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Apply the user's cached UI zoom BEFORE the first render so the loading
// screen doesn't paint at zoom=1 and then visibly jump once the BE
// settings load. The authoritative value is reconciled in bootstrap().
applyCachedZoom();

// We only have one visual layout — the App shell — but we still wrap
// it in @solidjs/router so the URL can mirror the active scope
// (project / worktree / pane / chat / file). The catch-all `*` route
// lets us read params and query strings anywhere via `useLocation` /
// `useParams` while keeping App as the sole rendered child.
//
// Routable URL shape:
//   /                                         → no scope (landing)
//   /p/:projectId                             → project root scope
//   /p/:projectId/w/:worktreeId               → worktree scope
//   ?pane=chat|editor|terminal|notes          → active pane
//   ?chat=:chatId                             → active chat tab
//   ?file=<urlencoded absolute path>          → active editor file
// Auth gate: resolve the BE's auth state ONCE before mounting the app.
// - auth disabled (the default) → render the app immediately.
// - auth enabled + valid session → render the app.
// - auth enabled + no session → redirect straight to Google (no login
//   screen). We show a blank splash while the redirect navigates so the
//   app shell (and its "open a folder" empty state) never flashes and
//   makes it look like data was lost.
function Root() {
  const [gate] = createResource(async () => {
    const cfg = await api.authConfig().catch(() => ({ enabled: false, provider: "" }));
    // Tell the client layer whether to send credentials. MUST run before
    // any other API call so we never send `credentials:"include"` to an
    // auth-off BE (whose `*` CORS would then block every request).
    setAuthEnabled(cfg.enabled);
    if (!cfg.enabled) return { show: "app" as const };
    const me = await api.authProbe().catch(() => null);
    if (me?.authenticated) return { show: "app" as const };
    // Forbidden account (BE bounced back with ?auth_error): show a
    // message instead of redirecting, else we'd loop back to Google.
    if (new URLSearchParams(window.location.search).has("auth_error")) {
      return { show: "forbidden" as const };
    }
    window.location.href = api.loginUrl();
    return { show: "redirecting" as const };
  });
  return (
    <Show
      when={gate()}
      fallback={<div class="flex h-screen w-screen items-center justify-center bg-bg-1" />}
    >
      <Switch fallback={<div class="flex h-screen w-screen items-center justify-center bg-bg-1" />}>
        <Match when={gate()!.show === "app"}>
          <Router>
            <Route path="*" component={App} />
          </Router>
        </Match>
        <Match when={gate()!.show === "forbidden"}>
          <div class="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-bg-1 text-fg">
            <p class="text-[14px]">That account isn't allowed.</p>
            <a href={api.loginUrl()} class="ag-btn ag-btn-primary ag-btn-sm">
              Try another account
            </a>
          </div>
        </Match>
      </Switch>
    </Show>
  );
}

render(
  () => (
    <>
      <Root />
      {/* ToastHost lives OUTSIDE the router so route transitions
          never unmount / re-create it. Toasts persist across scope
          switches and page navigations. */}
      <ToastHost />
    </>
  ),
  root,
);
