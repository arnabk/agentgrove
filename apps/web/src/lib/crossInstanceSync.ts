import { onCleanup, onMount } from "solid-js";
import { openWs } from "../api/client";
import { bootstrap, refreshProjects, refreshWorktreesForProject, state } from "../stores/app";

/**
 * Cross-instance synchronisation via the BE's `sync` WebSocket
 * topic.
 *
 * Unlike `crossTabs.ts` (which only reaches same-origin same-
 * instance browser tabs via BroadcastChannel + localStorage),
 * this subscriber works for ANY two clients connected to the
 * same BE — Firefox + Chrome, your laptop + your desktop, two
 * different machines on the same loopback tunnel. It's the only
 * way to keep state in step when "tabs" aren't on the same
 * instance.
 *
 * Wire by calling `installCrossInstanceSync()` once at the App
 * level (in onMount). It opens a single long-lived WS to
 * `/ws?topic=sync`, parses incoming frames, and triggers
 * targeted refresh calls against the affected stores:
 *
 *   project_created / deleted / updated → refreshProjects()
 *   worktree_created / updated / deleted / restored
 *                       → refreshWorktreesForProject(project_id)
 *   chat_created / updated → caller-supplied chat-list refresh
 *   scratchpad_updated → NotesPane's reload effect (driven by
 *                        the `notesUpdatedAt` signal we expose
 *                        below; NotesPane subscribes via
 *                        `useScratchpadSignal` to avoid a tight
 *                        coupling between this module and the
 *                        pane).
 *
 * Reconnect: if the WS closes (e.g. BE restart) we back off
 * starting at 1s and capped at 10s. The BE's logbus replays
 * recent history on subscribe, so we don't have to ask for a
 * resync — the frames we missed during the outage will arrive
 * in the replay batch.
 */

export type SyncFrame =
  | { kind: "project_created"; project_id: string }
  | { kind: "project_deleted"; project_id: string }
  | { kind: "project_updated"; project_id: string }
  | {
      kind: "worktree_created";
      worktree_id: string;
      project_id: string;
    }
  | {
      kind: "worktree_updated";
      worktree_id: string;
      project_id: string;
    }
  | {
      kind: "worktree_deleted";
      worktree_id: string;
      project_id: string;
    }
  | {
      kind: "worktree_restored";
      worktree_id: string;
      project_id: string;
    }
  | {
      kind: "chat_created";
      chat_id: string;
      project_id: string;
      worktree_id: string | null;
    }
  | {
      kind: "chat_updated";
      chat_id: string;
      project_id: string;
      worktree_id: string | null;
    }
  | {
      kind: "scratchpad_updated";
      project_id: string;
      updated_at: string;
    };

const listeners = new Set<(frame: SyncFrame) => void>();

/** Subscribe an extra handler — used by NotesPane + ChatPane to
 *  trigger their own targeted reloads on top of the global
 *  store refresh this module does for projects + worktrees. */
export function subscribeToSync(fn: (frame: SyncFrame) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Solid convenience: scope a subscription to a component lifetime. */
export function useSyncSubscription(fn: (frame: SyncFrame) => void) {
  let off: (() => void) | null = null;
  onMount(() => {
    off = subscribeToSync(fn);
  });
  onCleanup(() => {
    off?.();
  });
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1_000;
const RECONNECT_MAX = 10_000;
let closedByCaller = false;

function connect() {
  if (closedByCaller) return;
  try {
    socket = openWs("sync");
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    reconnectDelay = 1_000;
  });
  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    // Subscribed hello frames look like {"subscribed":"sync"} —
    // skip them.
    if (typeof obj.subscribed === "string") return;
    if (typeof obj.kind !== "string") return;
    void handleFrame(obj as unknown as SyncFrame);
  });
  socket.addEventListener("close", () => {
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    try {
      socket?.close();
    } catch {
      // ignore
    }
  });
}

function scheduleReconnect() {
  if (closedByCaller) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    connect();
  }, reconnectDelay);
}

async function handleFrame(frame: SyncFrame) {
  switch (frame.kind) {
    case "project_created":
    case "project_deleted":
    case "project_updated": {
      // Don't loop forever on initial boot — the bootstrap that
      // already ran filled state.projects. Refresh asynchronously
      // so the in-store list catches up.
      await refreshProjects();
      // Update worktrees too in case the deletion cascaded.
      if (frame.kind !== "project_created") {
        // best-effort; safe to skip on create (no worktrees yet)
        for (const pid of state.projects.map((p) => p.id)) {
          await refreshWorktreesForProject(pid);
        }
      }
      break;
    }
    case "worktree_created":
    case "worktree_updated":
    case "worktree_deleted":
    case "worktree_restored": {
      await refreshWorktreesForProject(frame.project_id);
      break;
    }
    // chat_created / chat_updated / scratchpad_updated are
    // handled by per-pane subscribers via the `listeners` Set so
    // the global store stays small. We DO still notify them
    // here.
    default:
      break;
  }
  for (const fn of listeners) {
    try {
      fn(frame);
    } catch (e) {
      console.error("[sync] listener threw", e);
    }
  }
  // Avoid an unused-warning when bootstrap is referenced but not
  // called: pull it in so callers can verify the import resolves.
  void bootstrap;
}

/** Install the global subscriber. Idempotent — calling twice
 *  reuses the existing connection. Returns a dispose function
 *  the App can call on unmount (rare; the WS lives the lifetime
 *  of the page). */
export function installCrossInstanceSync(): () => void {
  if (socket) return () => {};
  closedByCaller = false;
  connect();
  return () => {
    closedByCaller = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      socket?.close();
    } catch {
      // ignore
    }
    socket = null;
  };
}
