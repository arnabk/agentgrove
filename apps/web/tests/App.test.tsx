import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import App from "../src/App";

/** Helper that returns 200 + empty array for any list endpoint and the
 *  themes endpoint, simulating a freshly-booted local BE. */
function mockBackend() {
  return vi.fn(async (url: RequestInfo) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/api/themes") || u.endsWith("/api/projects")) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 200 });
  });
}

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads straight into the shell — no login, no token", async () => {
    const fetchMock = mockBackend();
    vi.stubGlobal("fetch", fetchMock);
    const { findByTestId } = render(() => <App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(await findByTestId("app-root")).toBeTruthy();
  });

  it("shows the welcome screen when no projects exist", async () => {
    const fetchMock = mockBackend();
    vi.stubGlobal("fetch", fetchMock);
    const { findByTestId } = render(() => <App />);
    // Welcome takes over the main area when projects.length === 0.
    expect(await findByTestId("welcome")).toBeTruthy();
  });
});
