import { describe, expect, it } from "vitest";
import { ALL_CELESTIAL, extractVisits, suggestBranchName, visitsByKind } from "./celestial";

describe("celestial", () => {
  it("suggests unique feature/ names", () => {
    const taken = new Set<string>();
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = suggestBranchName(taken);
      expect(name).toMatch(/^feature\/[a-z0-9-]+$/);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
      names.push(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("avoids all taken names", () => {
    const taken = new Set(
      ALL_CELESTIAL.map((b) => `feature/${b.display.toLowerCase().replace(/\s+/g, "-")}`),
    );
    const name = suggestBranchName(taken);
    expect(name).toMatch(/^feature\/[a-z0-9-]+-\w{4}$/);
  });

  it("extracts visits from branch names", () => {
    const visits = extractVisits([
      "feature/mars",
      "feature/sirius",
      "feature/andromeda",
      "feature/venus",
      "feature/unknown",
    ]);
    expect(visits).toHaveLength(4);
    expect(visits.map((v) => v.display)).toEqual(["Mars", "Sirius", "Andromeda", "Venus"]);
  });

  it("groups visits by kind", () => {
    const byKind = visitsByKind(
      extractVisits(["feature/mars", "feature/sirius", "feature/andromeda"]),
    );
    expect(byKind.planet.map((v) => v.display)).toEqual(["Mars"]);
    expect(byKind.star.map((v) => v.display)).toEqual(["Sirius"]);
    expect(byKind.galaxy.map((v) => v.display)).toEqual(["Andromeda"]);
  });
});
