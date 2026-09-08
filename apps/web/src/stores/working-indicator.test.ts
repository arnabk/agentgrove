import { describe, it, expect, beforeEach } from "vitest";
import { setActiveWork, isScopeWorking } from "./app";

/**
 * Regression test for the "parent folder lights up when a worktree is
 * working" bug. The left rail shows a working dot on a project row via
 * `isScopeWorking(pid, null)` (project ROOT) and on a worktree row via
 * `isScopeWorking(pid, wid)`. The active-work set is built in App.tsx
 * from `GET /api/chats/active`.
 *
 * The invariant this locks: a busy WORKTREE chat must NOT mark the
 * project root as working. Only a project-root chat does that. Past
 * fixes regressed because the poll added a bare `pid` key for every
 * row (including worktree rows), which collided with the root key.
 */
describe("working indicator scope isolation", () => {
  const pid = "11111111-1111-1111-1111-111111111111";
  const wid = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => setActiveWork(new Set()));

  it("a busy worktree does not mark the project root as working", () => {
    // This is exactly what App.tsx now stores for a busy worktree chat:
    // only the `pid::wid` key, never a bare `pid`.
    setActiveWork(new Set([`${pid}::${wid}`]));
    expect(isScopeWorking(pid, wid)).toBe(true);
    expect(isScopeWorking(pid, null)).toBe(false);
  });

  it("a busy project-root chat marks only the root", () => {
    setActiveWork(new Set([pid]));
    expect(isScopeWorking(pid, null)).toBe(true);
    expect(isScopeWorking(pid, wid)).toBe(false);
  });

  it("root and worktree can be busy independently", () => {
    setActiveWork(new Set([pid, `${pid}::${wid}`]));
    expect(isScopeWorking(pid, null)).toBe(true);
    expect(isScopeWorking(pid, wid)).toBe(true);
  });
});
