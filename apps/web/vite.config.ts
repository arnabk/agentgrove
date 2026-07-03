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
    strictPort: false,
    host: "0.0.0.0",
    allowedHosts: true,
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
