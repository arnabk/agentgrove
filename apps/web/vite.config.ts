import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "node:path";

/**
 * COOP + COEP enable `crossOriginIsolated`, which is required by
 * `performance.measureUserAgentSpecificMemory()` (the only browser
 * API that reports near-Chrome-Task-Manager whole-tab memory).
 *
 * Same-origin assets are unaffected. COEP=require-corp does mean any
 * cross-origin resource must opt in with `Cross-Origin-Resource-
 * Policy: cross-origin` (or be served with CORS). We currently load
 * only same-origin code/CSS and system fonts, so this is safe.
 */
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    // Pin the UI to :5173. The frontend's API base URL is derived from
    // this port (api/client.ts maps :5173 → backend :4317), so if Vite
    // silently fell back to :5174 (the default when 5173 is busy) the
    // app would load but never reach the backend. Fail loudly instead.
    strictPort: true,
    // Loopback by default: the dev server proxies the whole app (API,
    // websocket, terminals) and has no login unless Google auth is set.
    // Opt in to LAN exposure with AGENTGROVE_BIND=0.0.0.0 (same knob as
    // the backend). A tunnel on this machine still works on loopback.
    host: process.env.AGENTGROVE_BIND || "127.0.0.1",
    allowedHosts: true,
    headers: isolationHeaders,
    // Same-origin BE access when the FE is reached through a reverse
    // tunnel (no :5173 in the URL → baseUrl() is "" → relative calls).
    // Local :5173 use still talks to :4317 directly.
    proxy: {
      "/api": { target: "http://127.0.0.1:4317", ws: true },
      "/ws": { target: "http://127.0.0.1:4317", ws: true },
      "/health": "http://127.0.0.1:4317",
    },
    // The dev server's /@fs route bypasses BE auth. Confine it to the
    // FE package + installed deps, and hard-deny the state dir (Google
    // secret, session-sealing key, DB) in case the allow list widens.
    fs: {
      strict: true,
      allow: [__dirname, path.resolve(__dirname, "../../node_modules")],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", "**/.data/**"],
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
