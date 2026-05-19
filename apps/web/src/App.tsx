import { createEffect, createSignal } from "solid-js";

export default function App() {
  const [theme, setTheme] = createSignal<"light" | "dark">("dark");

  // Reflect theme on <html> so global CSS variable overrides take effect
  // for <body> (which carries the Tailwind bg-bg / text-fg classes).
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", theme());
  });

  return (
    <main data-testid="app-root" data-theme={theme()} class="min-h-screen p-8 flex flex-col gap-4">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-semibold">AgentGrove</h1>
        <button
          type="button"
          class="px-3 py-1 rounded border border-muted"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme() === "dark" ? "light" : "dark")}
        >
          Theme: {theme()}
        </button>
      </header>
      <p class="text-muted">Local-first agentic developer workspace.</p>
    </main>
  );
}
