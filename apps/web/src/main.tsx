import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import App from "./App";
import { applyCachedZoom } from "./stores/app";
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
render(
  () => (
    <Router>
      <Route path="*" component={App} />
    </Router>
  ),
  root,
);
