import { describe, it, expect, vi } from "vitest";

vi.mock("@/core/api/client", () => ({
  api: { baseUrl: () => "http://127.0.0.1:4317" },
}));

import type { AgentEvent, Prompt } from "@/core/api/client";
import {
  MAX_EVENTS_IN_VIEW,
  MAX_PROMPTS_IN_VIEW,
  appendEventBounded,
  applyWsFrame,
  assistantText,
  chatWsUrl,
  errorMessages,
  freshChatStore,
  isPromptPending,
  parseWsFrame,
  thinkingText,
  toolEvents,
  type ChatStore,
} from "@/core/chat/chatStream";

function prompt(id: string, events: AgentEvent[] = []): Prompt {
  return { id, events } as unknown as Prompt;
}

function storeWith(...prompts: Prompt[]): ChatStore {
  return { ...freshChatStore(), prompts };
}

describe("freshChatStore", () => {
  it("starts empty and not loading", () => {
    expect(freshChatStore()).toEqual({
      view: null,
      prompts: [],
      liveTokens: {},
      liveThinking: {},
      loadingOlder: false,
      atStart: false,
    });
  });

  it("hands out a fresh object each call so chats can't share buffers", () => {
    const a = freshChatStore();
    const b = freshChatStore();
    a.liveTokens["p1"] = "x";
    expect(b.liveTokens).toEqual({});
  });
});

describe("parseWsFrame", () => {
  it("decodes a prompt event frame", () => {
    const raw = JSON.stringify({ prompt_id: "p1", event: { type: "done" } });
    expect(parseWsFrame(raw)).toEqual({ promptId: "p1", event: { type: "done" } });
  });

  it("ignores the subscription hello", () => {
    expect(parseWsFrame(JSON.stringify({ subscribed: "chat:abc" }))).toBeNull();
  });

  it("ignores frames missing a prompt id or an event", () => {
    expect(parseWsFrame(JSON.stringify({ event: { type: "done" } }))).toBeNull();
    expect(parseWsFrame(JSON.stringify({ prompt_id: "p1" }))).toBeNull();
  });

  it("survives malformed input rather than throwing at the socket", () => {
    expect(parseWsFrame("not json")).toBeNull();
    expect(parseWsFrame("null")).toBeNull();
    expect(parseWsFrame("42")).toBeNull();
    expect(parseWsFrame(new ArrayBuffer(4))).toBeNull();
    expect(parseWsFrame(undefined)).toBeNull();
  });
});

describe("appendEventBounded", () => {
  it("appends freely below the cap", () => {
    const events: AgentEvent[] = [];
    appendEventBounded(events, { type: "done" } as AgentEvent, 3);
    expect(events).toHaveLength(1);
  });

  it("inserts a Truncated sentinel and drops the oldest real event at the cap", () => {
    const events = [
      { type: "tool_use", name: "a" },
      { type: "tool_use", name: "b" },
      { type: "tool_use", name: "c" },
    ] as unknown as AgentEvent[];
    appendEventBounded(events, { type: "done" } as AgentEvent, 3);

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "truncated", dropped: 1 });
    // "a" was the oldest real event and is gone; the tail is preserved.
    expect(events[1]).toMatchObject({ name: "c" });
    expect(events[2]).toMatchObject({ type: "done" });
  });

  it("increments the existing sentinel instead of stacking sentinels", () => {
    const events = [
      { type: "truncated", dropped: 4 },
      { type: "tool_use", name: "b" },
      { type: "tool_use", name: "c" },
    ] as unknown as AgentEvent[];
    appendEventBounded(events, { type: "done" } as AgentEvent, 3);

    expect(events.filter((e) => e.type === "truncated")).toHaveLength(1);
    expect(events[0]).toEqual({ type: "truncated", dropped: 5 });
    expect(events[2]).toMatchObject({ type: "done" });
  });

  it("never lets a prompt grow past the cap under sustained tool spam", () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 50; i++) {
      appendEventBounded(events, { type: "tool_use", name: `t${i}` } as unknown as AgentEvent, 10);
    }
    expect(events).toHaveLength(10);
    expect(events[0]).toMatchObject({ type: "truncated", dropped: 40 });
    expect(events[9]).toMatchObject({ name: "t49" });
  });
});

describe("applyWsFrame", () => {
  it("accumulates token deltas in liveTokens without touching events", () => {
    const s = storeWith(prompt("p1"));
    applyWsFrame(s, { promptId: "p1", event: { type: "token", text: "Hel" } as AgentEvent });
    applyWsFrame(s, { promptId: "p1", event: { type: "token", text: "lo" } as AgentEvent });

    expect(s.liveTokens["p1"]).toBe("Hello");
    // The BE mirrors tokens into events itself; double-pushing would
    // render the answer twice after a refetch.
    expect(s.prompts[0]!.events).toHaveLength(0);
  });

  it("accumulates thinking separately so the two streams don't collide", () => {
    const s = storeWith(prompt("p1"));
    applyWsFrame(s, { promptId: "p1", event: { type: "thinking", text: "hmm" } as AgentEvent });
    applyWsFrame(s, { promptId: "p1", event: { type: "token", text: "ok" } as AgentEvent });

    expect(s.liveThinking["p1"]).toBe("hmm");
    expect(s.liveTokens["p1"]).toBe("ok");
  });

  it("buffers tokens for a prompt that hasn't arrived in the timeline yet", () => {
    const s = storeWith();
    applyWsFrame(s, { promptId: "ghost", event: { type: "token", text: "hi" } as AgentEvent });
    expect(s.liveTokens["ghost"]).toBe("hi");
  });

  it("drops non-token events for an unknown prompt instead of throwing", () => {
    const s = storeWith(prompt("p1"));
    applyWsFrame(s, { promptId: "ghost", event: { type: "done" } as AgentEvent });
    expect(s.prompts[0]!.events).toHaveLength(0);
  });

  it("appends tool events to the addressed prompt only", () => {
    const s = storeWith(prompt("p1"), prompt("p2"));
    applyWsFrame(s, {
      promptId: "p2",
      event: { type: "tool_use", name: "Read" } as unknown as AgentEvent,
    });

    expect(s.prompts[0]!.events).toHaveLength(0);
    expect(s.prompts[1]!.events).toHaveLength(1);
  });

  it("clears the live buffers on done so renders fall back to persisted events", () => {
    const s = storeWith(prompt("p1"));
    applyWsFrame(s, { promptId: "p1", event: { type: "token", text: "hi" } as AgentEvent });
    applyWsFrame(s, { promptId: "p1", event: { type: "thinking", text: "hm" } as AgentEvent });
    applyWsFrame(s, { promptId: "p1", event: { type: "done" } as AgentEvent });

    expect(s.liveTokens["p1"]).toBeUndefined();
    expect(s.liveThinking["p1"]).toBeUndefined();
    expect(s.prompts[0]!.events).toEqual([{ type: "done" }]);
  });

  it("clears the live buffers on error too", () => {
    const s = storeWith(prompt("p1"));
    applyWsFrame(s, { promptId: "p1", event: { type: "token", text: "partial" } as AgentEvent });
    applyWsFrame(s, {
      promptId: "p1",
      event: { type: "error", message: "boom" } as unknown as AgentEvent,
    });

    expect(s.liveTokens["p1"]).toBeUndefined();
    expect(s.prompts[0]!.events).toHaveLength(1);
  });

  it("resets the prompt on retry so the re-dispatch streams in cleanly", () => {
    const s = storeWith(
      prompt("p1", [{ type: "tool_use", name: "Read" } as unknown as AgentEvent]),
    );
    applyWsFrame(s, { promptId: "p1", event: { type: "token", text: "stale" } as AgentEvent });

    const retry = { type: "retry", message: "stale session" } as unknown as AgentEvent;
    applyWsFrame(s, { promptId: "p1", event: retry });

    expect(s.liveTokens["p1"]).toBeUndefined();
    expect(s.liveThinking["p1"]).toBeUndefined();
    expect(s.prompts[0]!.events).toEqual([retry]);
  });

  it("bounds a prompt's events at the shared cap", () => {
    const s = storeWith(prompt("p1"));
    for (let i = 0; i < MAX_EVENTS_IN_VIEW + 25; i++) {
      applyWsFrame(s, {
        promptId: "p1",
        event: { type: "tool_use", name: `t${i}` } as unknown as AgentEvent,
      });
    }
    expect(s.prompts[0]!.events).toHaveLength(MAX_EVENTS_IN_VIEW);
  });
});

describe("caps", () => {
  it("keeps the ADR-0006 retention budget", () => {
    expect(MAX_PROMPTS_IN_VIEW).toBe(600);
    expect(MAX_EVENTS_IN_VIEW).toBe(400);
  });
});

describe("chatWsUrl", () => {
  it("builds a ws:// URL on /ws with the topic as a query param", () => {
    expect(chatWsUrl("chat:abc")).toBe("ws://127.0.0.1:4317/ws?topic=chat%3Aabc");
  });
});

describe("per-prompt derivations", () => {
  const tokens = (...texts: string[]) =>
    texts.map((text) => ({ type: "token", text }) as AgentEvent);

  describe("assistantText", () => {
    it("concatenates persisted token events", () => {
      expect(assistantText(prompt("p1", tokens("Hello, ", "world")), {})).toBe("Hello, world");
    });

    it("prefers the live buffer so a streaming reply isn't shown twice", () => {
      // The BE mirrors coalesced tokens into events as well, so during a
      // turn both sources hold text. Summing them would duplicate it.
      const p = prompt("p1", tokens("Hel", "lo"));
      expect(assistantText(p, { p1: "Hello" })).toBe("Hello");
    });

    it("treats an empty live buffer as authoritative, not as absent", () => {
      expect(assistantText(prompt("p1", tokens("stale")), { p1: "" })).toBe("");
    });

    it("ignores thinking and tool events", () => {
      const p = prompt("p1", [
        { type: "thinking", text: "hmm" },
        { type: "tool_call", name: "Read" },
        { type: "token", text: "answer" },
      ] as unknown as AgentEvent[]);
      expect(assistantText(p, {})).toBe("answer");
    });
  });

  describe("thinkingText", () => {
    it("concatenates thinking events and ignores tokens", () => {
      const p = prompt("p1", [
        { type: "thinking", text: "step 1 " },
        { type: "token", text: "answer" },
        { type: "thinking", text: "step 2" },
      ] as unknown as AgentEvent[]);
      expect(thinkingText(p, {})).toBe("step 1 step 2");
    });

    it("is empty for a model that doesn't think", () => {
      expect(thinkingText(prompt("p1", tokens("hi")), {})).toBe("");
    });

    it("prefers its own live buffer, not the token one", () => {
      expect(thinkingText(prompt("p1"), { p1: "live thought" })).toBe("live thought");
    });
  });

  describe("toolEvents", () => {
    it("keeps tool activity, errors and the truncation sentinel", () => {
      const p = prompt("p1", [
        { type: "token", text: "x" },
        { type: "tool_call", name: "Read" },
        { type: "thinking", text: "hm" },
        { type: "tool_result", output: "ok" },
        { type: "error", message: "boom" },
        { type: "truncated", dropped: 3 },
        { type: "done" },
      ] as unknown as AgentEvent[]);
      expect(toolEvents(p).map((e) => e.type)).toEqual([
        "tool_call",
        "tool_result",
        "error",
        "truncated",
      ]);
    });
  });

  describe("errorMessages", () => {
    it("collects provider error text so a failed turn never looks empty", () => {
      const p = prompt("p1", [
        { type: "error", message: "rate limited" },
        { type: "token", text: "partial" },
        { type: "error", message: "cancelled by user" },
      ] as unknown as AgentEvent[]);
      expect(errorMessages(p)).toEqual(["rate limited", "cancelled by user"]);
    });

    it("is empty for a clean turn", () => {
      expect(errorMessages(prompt("p1", [{ type: "done" }] as AgentEvent[]))).toEqual([]);
    });
  });

  describe("isPromptPending", () => {
    it("treats an accepted-but-silent prompt as working", () => {
      expect(isPromptPending(prompt("p1"), {}, {}, true)).toBe(true);
    });

    it("is working while tokens or thinking are streaming", () => {
      expect(isPromptPending(prompt("p1", tokens("hi")), { p1: "hi" }, {}, true)).toBe(true);
      expect(isPromptPending(prompt("p1"), {}, { p1: "hm" }, true)).toBe(true);
    });

    it("is finished on done and on error", () => {
      expect(isPromptPending(prompt("p1", [{ type: "done" }] as AgentEvent[]), {}, {}, true)).toBe(
        false,
      );
      expect(
        isPromptPending(
          prompt("p1", [{ type: "error", message: "x" }] as unknown as AgentEvent[]),
          {},
          {},
          true,
        ),
      ).toBe(false);
    });

    it("is working when the last event is non-terminal", () => {
      const p = prompt("p1", [{ type: "tool_call", name: "Read" }] as unknown as AgentEvent[]);
      expect(isPromptPending(p, {}, {}, true)).toBe(true);
    });

    it("never reports a non-tail prompt as working, even mid-stream", () => {
      // A dropped done/error frame would otherwise leave an older bubble
      // stuck on "working…" for the rest of the session.
      expect(isPromptPending(prompt("p1"), { p1: "partial" }, {}, false)).toBe(false);
      const p = prompt("p1", [{ type: "tool_call", name: "Read" }] as unknown as AgentEvent[]);
      expect(isPromptPending(p, {}, {}, false)).toBe(false);
    });
  });
});
