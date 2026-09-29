import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "@/core/api/client";

/**
 * `whoami` reports the *server's* OS user, so on a multi-device
 * instance every client would post under the same name. When auth is
 * on the session email is a real per-person identity and must win.
 */
describe("api.teamChatIdentity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prefers the authenticated email over the server's OS user", async () => {
    vi.spyOn(api, "authProbe").mockResolvedValue({
      authenticated: true,
      auth_enabled: true,
      email: "dev@example.com",
    });
    const whoami = vi.spyOn(api, "teamChatWhoami");

    expect(await api.teamChatIdentity()).toBe("dev@example.com");
    expect(whoami).not.toHaveBeenCalled();
  });

  it("falls back to the OS user when auth is off", async () => {
    vi.spyOn(api, "authProbe").mockResolvedValue({
      authenticated: false,
      auth_enabled: false,
      email: "p3156134",
    });
    vi.spyOn(api, "teamChatWhoami").mockResolvedValue({ username: "p3156134" });

    expect(await api.teamChatIdentity()).toBe("p3156134");
  });

  it("falls back to the OS user when the session has expired", async () => {
    vi.spyOn(api, "authProbe").mockResolvedValue(null);
    vi.spyOn(api, "teamChatWhoami").mockResolvedValue({ username: "osuser" });

    expect(await api.teamChatIdentity()).toBe("osuser");
  });

  it("falls back when the auth probe throws", async () => {
    vi.spyOn(api, "authProbe").mockRejectedValue(new Error("network"));
    vi.spyOn(api, "teamChatWhoami").mockResolvedValue({ username: "osuser" });

    expect(await api.teamChatIdentity()).toBe("osuser");
  });

  it("ignores an authenticated session with no email", async () => {
    vi.spyOn(api, "authProbe").mockResolvedValue({
      authenticated: true,
      auth_enabled: true,
      email: "",
    });
    vi.spyOn(api, "teamChatWhoami").mockResolvedValue({ username: "osuser" });

    expect(await api.teamChatIdentity()).toBe("osuser");
  });

  it("degrades to a placeholder rather than throwing when both fail", async () => {
    vi.spyOn(api, "authProbe").mockRejectedValue(new Error("down"));
    vi.spyOn(api, "teamChatWhoami").mockRejectedValue(new Error("down"));

    expect(await api.teamChatIdentity()).toBe("dev");
  });
});
