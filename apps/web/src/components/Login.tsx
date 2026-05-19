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
    <div class="min-h-screen flex items-center justify-center p-8 bg-bg">
      <form
        onSubmit={submit}
        class="w-full max-w-sm rounded-xl border border-border bg-bg-1 p-7 shadow-2xl"
        data-testid="login-form"
      >
        <div class="flex items-center gap-2.5 mb-1">
          <Logo />
          <h1 class="text-base font-semibold tracking-tight text-fg">AgentGrove</h1>
        </div>
        <p class="text-[13px] text-fg-muted mb-5">
          Paste the token printed by <code class="font-mono text-[12px] text-fg">just start</code>.
        </p>
        <label class="block text-[12px] font-medium text-fg-muted mb-1.5">Bearer token</label>
        <input
          type="password"
          placeholder="•••••••••••••••••"
          class="ag-input mb-4"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          aria-label="bearer token"
          data-testid="login-token"
          autofocus
        />
        <button
          type="submit"
          class="ag-btn ag-btn-primary w-full justify-center"
          data-testid="login-submit"
        >
          Connect
        </button>
        {err() && (
          <p class="mt-3 text-[12px] text-danger" data-testid="login-error">
            {err()}
          </p>
        )}
        {state.authError && !err() && (
          <p class="mt-3 text-[12px] text-danger" data-testid="login-server-error">
            {state.authError}
          </p>
        )}
      </form>
    </div>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2 4 7v10l8 5 8-5V7l-8-5Z"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path
        d="M12 12 4 7m8 5 8-5m-8 5v10"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}
