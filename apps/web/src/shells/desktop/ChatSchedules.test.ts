import { describe, it, expect } from "vitest";
import { formatInterval, formatUntil } from "@/shells/desktop/ChatSchedules";

describe("schedule labels", () => {
  it("formats intervals in the largest whole unit", () => {
    expect(formatInterval(45)).toBe("45s");
    expect(formatInterval(90)).toBe("90s");
    expect(formatInterval(120)).toBe("2m");
    expect(formatInterval(7200)).toBe("2h");
    expect(formatInterval(172800)).toBe("2d");
  });
  it("formats time until the next run", () => {
    expect(formatUntil(1_000, 5_000)).toBe("now");
    expect(formatUntil(42_000, 0)).toBe("in 42s");
    expect(formatUntil(10 * 60_000 + 20_000, 0)).toBe("in 10m");
  });
});
