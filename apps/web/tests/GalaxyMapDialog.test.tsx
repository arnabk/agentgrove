import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";
import GalaxyMapDialog from "../src/components/GalaxyMapDialog";

// jsdom has no canvas 2d context; stub it so the dialog's draw() is a
// no-op and we can assert on the DOM-rendered visited panel instead.
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

describe("GalaxyMapDialog visit counts", () => {
  it("shows a ×N badge for bodies visited more than once", async () => {
    const visited = () => new Set(["Mars", "Sirius"]);
    const counts = () =>
      new Map<string, number>([
        ["Mars", 3],
        ["Sirius", 1],
      ]);
    const { findByTestId, queryByTestId } = render(() => (
      <GalaxyMapDialog visited={visited} counts={counts} onClose={() => {}} />
    ));

    const marsBadge = await findByTestId("galaxy-count-Mars");
    expect(marsBadge.textContent).toBe("×3");
    // A single visit renders no badge.
    expect(queryByTestId("galaxy-count-Sirius")).toBeNull();
  });

  it("treats a body with no count entry as a single visit (no badge)", () => {
    const visited = () => new Set(["Vega"]);
    const counts = () => new Map<string, number>();
    const { queryByTestId } = render(() => (
      <GalaxyMapDialog visited={visited} counts={counts} onClose={() => {}} />
    ));
    expect(queryByTestId("galaxy-count-Vega")).toBeNull();
  });
});
