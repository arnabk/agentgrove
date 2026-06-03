import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  state,
  setState,
  selectProject,
  selectWorktree,
  addTab,
  renameTab,
  currentScope,
  currentScopeKey,
} from "./app";

/**
 * Regression tests for per-scope tab placement.
 *
 * Chats and terminals are stored per scope (project root, or a specific
 * worktree of that project). A long-standing class of bug came from the
 * scope KEY being encoded one way when a tab was written and another way
 * when it was read back / persisted — so a terminal or chat created from
 * a worktree row "didn't open in the project it was created from".
 *
 * These lock the invariant: a tab added while scope X is active belongs
 * to scope X, and switching scopes shows exactly that scope's tabs.
 */

function resetStore() {
  // Wipe the per-scope map + selection between tests so state doesn't leak.
  setState("byScope", {});
  setState("selectedProjectId", null);
  setState("selectedWorktreeByProject", {});
}

describe("scope tab placement", () => {
  beforeEach(() => {
    // selectProject fires a best-effort worktree refresh; stub fetch so it
    // resolves to an empty list instead of hitting the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    resetStore();
  });

  it("adds a tab to the project-root scope when no worktree is selected", () => {
    const pid = "11111111-1111-1111-1111-111111111111";
    selectProject(pid);

    const res = addTab({ kind: "terminal", id: "term-1", cwd: "/p", label: "term 1" });
    expect(res.ok).toBe(true);

    // The tab is in the current (project-root) scope and active.
    expect(currentScope()?.tabs.map((t) => t.id)).toEqual(["term-1"]);
    expect(currentScope()?.activeTab).toBe("term-1");
    expect(currentScopeKey()).toBe(pid);
  });

  it("adds a tab to the worktree scope when a worktree is selected", () => {
    const pid = "22222222-2222-2222-2222-222222222222";
    const wid = "33333333-3333-3333-3333-333333333333";
    selectProject(pid);
    selectWorktree(pid, wid);

    addTab({ kind: "chat", id: "chat-1", title: "hi" });

    // The worktree scope holds the tab...
    const wtKey = currentScopeKey();
    expect(wtKey).toBe(`${pid}::${wid}`);
    expect(state.byScope[wtKey!]?.tabs.map((t) => t.id)).toEqual(["chat-1"]);

    // ...and the project-root scope does NOT (this is the regression: a
    // mismatched key used to leak the tab into / hide it from the root).
    expect(state.byScope[pid]?.tabs ?? []).toEqual([]);
  });

  it("keeps each scope's tabs separate when switching back and forth", () => {
    const pid = "44444444-4444-4444-4444-444444444444";
    const wid = "55555555-5555-5555-5555-555555555555";

    // Root scope: one terminal.
    selectProject(pid);
    selectWorktree(pid, null);
    addTab({ kind: "terminal", id: "root-term", cwd: "/p", label: "term 1" });

    // Worktree scope: one chat.
    selectWorktree(pid, wid);
    addTab({ kind: "chat", id: "wt-chat", title: "wt" });

    // Switch back to root — we see the root terminal, not the wt chat.
    selectWorktree(pid, null);
    expect(currentScope()?.tabs.map((t) => t.id)).toEqual(["root-term"]);

    // Switch to the worktree — we see the wt chat, not the root terminal.
    selectWorktree(pid, wid);
    expect(currentScope()?.tabs.map((t) => t.id)).toEqual(["wt-chat"]);
  });

  it("uses '::' as the scope-key separator so writeScopeLayout can split it", () => {
    // writeScopeLayout does `key.split("::")` to recover project_id +
    // worktree_id for the BE. If makeKey ever drifts back to a single
    // ":", that split breaks and worktree layouts persist under a bogus
    // project. Assert the contract directly.
    const pid = "66666666-6666-6666-6666-666666666666";
    const wid = "77777777-7777-7777-7777-777777777777";
    selectProject(pid);
    selectWorktree(pid, wid);

    const key = currentScopeKey()!;
    const [projectId, worktreeId] = key.split("::");
    expect(projectId).toBe(pid);
    expect(worktreeId).toBe(wid);
  });

  it("renames a chat tab's title and a terminal tab's label", () => {
    const pid = "88888888-8888-8888-8888-888888888888";
    selectProject(pid);
    addTab({ kind: "chat", id: "chat-r", title: "chat in self" });
    addTab({ kind: "terminal", id: "term-r", cwd: "/p", label: "term 1" });

    renameTab("chat-r", "Infra cost chat");
    renameTab("term-r", "build shell");

    const byId = (id: string) => currentScope()?.tabs.find((t) => t.id === id);
    expect((byId("chat-r") as { title: string }).title).toBe("Infra cost chat");
    expect((byId("term-r") as { label: string }).label).toBe("build shell");
  });

  it("ignores a blank rename (keeps the previous title)", () => {
    const pid = "99999999-9999-9999-9999-999999999999";
    selectProject(pid);
    addTab({ kind: "chat", id: "chat-b", title: "keep me" });

    renameTab("chat-b", "   ");

    const tab = currentScope()?.tabs.find((t) => t.id === "chat-b");
    expect((tab as { title: string }).title).toBe("keep me");
  });
});
