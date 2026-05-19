import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import App from "../src/App";

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders login when the BE is unreachable and no token is stored", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { findByTestId } = render(() => <App />);
    expect(await findByTestId("login-form")).toBeTruthy();
  });

  it("skips login when the BE has auth disabled (anon /whoami works)", async () => {
    const mock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/whoami")) {
        return new Response("authenticated", { status: 200 });
      }
      if (typeof url === "string" && url.endsWith("/api/themes")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (typeof url === "string" && url.endsWith("/api/projects")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", mock);
    const { findByTestId } = render(() => <App />);
    // Should reach the main shell since auth not required.
    await waitFor(() => expect(mock).toHaveBeenCalled());
    expect(await findByTestId("app-root")).toBeTruthy();
  });
});
