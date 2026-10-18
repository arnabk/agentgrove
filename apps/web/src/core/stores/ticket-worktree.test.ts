import { describe, it, expect } from "vitest";
import type { Worktree } from "@/core/api/client";
import { findTicketWorktree, setState } from "@/core/stores/app";

const wt = (id: string, branch: string, removed_at: string | null = null): Worktree => ({
  id,
  project_id: "p1",
  branch,
  base_ref: "HEAD",
  path: `/tmp/${id}`,
  status: "ready",
  pre_script: null,
  post_script: null,
  created_at: "",
  updated_at: "",
  removed_at,
});

describe("findTicketWorktree", () => {
  it("matches the ticket branch exactly by id, skipping removed worktrees", () => {
    setState("worktrees", {
      p1: [wt("old", "ticket/86b1-fix", "2026-01-01"), wt("other", "ticket/86b12-x")],
      p2: [wt("live", "ticket/86b1-fix-login")],
    });
    expect(findTicketWorktree("86b1")?.id).toBe("live");
    expect(findTicketWorktree("86b12")?.id).toBe("other");
    expect(findTicketWorktree("nope")).toBeUndefined();
  });
});
