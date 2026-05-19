import { createSignal } from "solid-js";
import { api } from "../api/client";
import { bootstrap, setState, state } from "../stores/app";

export default function Login() {
  const [token, setToken] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);

  async function submit(ev: SubmitEvent) {
    ev.preventDefault();
    setErr(null);
    api.setToken(token().trim());
    try {
      await api.whoami();
      setState("authError", null);
      await bootstrap();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
    }
  }

  return (
    <div class="min-h-screen flex items-center justify-center p-8">
      <form
        onSubmit={submit}
        class="w-full max-w-md flex flex-col gap-4 bg-[var(--ag-bg-elev)] p-6 rounded-lg border border-[var(--ag-muted)]"
        data-testid="login-form"
      >
        <h1 class="text-2xl font-semibold">AgentGrove</h1>
        <p class="text-sm text-[var(--ag-muted)]">
          Paste the token printed by <code>just start</code>.
        </p>
        <input
          type="password"
          placeholder="bearer token"
          class="px-3 py-2 rounded bg-transparent border border-[var(--ag-muted)] focus:outline-none focus:border-[var(--ag-accent)]"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          aria-label="bearer token"
          data-testid="login-token"
          autofocus
        />
        <button
          type="submit"
          class="px-4 py-2 rounded bg-[var(--ag-accent)] text-white"
          data-testid="login-submit"
        >
          Connect
        </button>
        {err() && (
          <p class="text-red-400 text-sm" data-testid="login-error">
            {err()}
          </p>
        )}
        {state.authError && !err() && (
          <p class="text-red-400 text-sm" data-testid="login-server-error">
            {state.authError}
          </p>
        )}
      </form>
    </div>
  );
}
