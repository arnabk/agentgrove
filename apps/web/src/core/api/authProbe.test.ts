import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, isAuthEnabled, setAuthEnabled } from "@/core/api/client";

/**
 * An auth-off backend answers with `Access-Control-Allow-Origin: *`.
 * Wildcard origin plus `credentials: "include"` is illegal, so the
 * browser blocks the request and logs a CORS error rather than sending
 * it. `authProbe` must therefore only ask for credentials when auth is
 * actually on.
 */
describe("api.authProbe credentials", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ authenticated: false, auth_enabled: false, email: "osuser" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAuthEnabled(false);
  });

  it("omits credentials when auth is off", async () => {
    setAuthEnabled(false);
    await api.authProbe();

    const init = fetchMock.mock.calls[0]![1];
    expect(init?.credentials).toBeUndefined();
  });

  it("sends credentials when auth is on, so the session cookie rides along", async () => {
    setAuthEnabled(true);
    await api.authProbe();

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: "include" });
  });

  it("hits /api/auth/me either way", async () => {
    await api.authProbe();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/auth/me");
  });

  it("returns null on 401 rather than throwing, so the caller can show a login screen", async () => {
    fetchMock.mockResolvedValue({ status: 401, ok: false });
    expect(await api.authProbe()).toBeNull();
  });

  it("reports the flag it was told at boot", () => {
    setAuthEnabled(true);
    expect(isAuthEnabled()).toBe(true);
    setAuthEnabled(false);
    expect(isAuthEnabled()).toBe(false);
  });
});
