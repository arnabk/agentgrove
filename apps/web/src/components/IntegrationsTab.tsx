import { For, Show, createSignal, onMount } from "solid-js";
import { api, type IntegrationSummary } from "../api/client";
import { confirm } from "./dialog";
import { pushToast } from "./Toast";

interface IntegrationDef {
  provider: string;
  label: string;
  icon: () => import("solid-js").JSX.Element;
  connectable: boolean;
  cli?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { provider: "github", label: "GitHub Issues", icon: GitHubIcon, connectable: false, cli: "gh" },
  { provider: "gitlab", label: "GitLab Issues", icon: GitLabIcon, connectable: false, cli: "glab" },
  { provider: "clickup", label: "ClickUp", icon: ClickUpIcon, connectable: true },
];

export default function IntegrationsTab() {
  const [summaries, setSummaries] = createSignal<IntegrationSummary[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal<string | null>(null);

  async function refresh() {
    try {
      setSummaries(await api.listIntegrations());
    } catch {
      // Keep whatever we had; the row falls back to "not connected".
    } finally {
      setLoading(false);
    }
  }

  onMount(() => void refresh());

  const summaryFor = (provider: string) => summaries().find((s) => s.provider === provider);

  function connect(provider: string) {
    const url = `${api.baseUrl}/api/integrations/${encodeURIComponent(provider)}/auth`;
    const popup = window.open(url, `ag-oauth-${provider}`, "width=800,height=600");
    if (!popup) {
      pushToast({
        title: "Popup blocked",
        message: "Allow popups for this site to connect the integration.",
        level: "error",
      });
      return;
    }
    setBusy(provider);
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        setBusy(null);
        void refresh();
      }
    }, 500);
  }

  async function disconnect(provider: string, label: string) {
    const ok = await confirm({
      title: "Disconnect integration",
      body: `Disconnect ${label}? You can reconnect any time.`,
      confirmLabel: "Disconnect",
      danger: true,
      testId: "confirm-disconnect-integration",
    });
    if (!ok) return;
    setBusy(provider);
    try {
      await api.disconnectIntegration(provider);
      pushToast({ title: `${label} disconnected`, message: "", level: "info" });
      await refresh();
    } catch (e) {
      pushToast({
        title: "Disconnect failed",
        message: e instanceof Error ? e.message : String(e),
        level: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="space-y-3" data-testid="settings-integrations-tab">
      <p class="text-[12.5px] text-fg-muted">
        Connect ticket sources so you can browse issues and spin up worktrees straight from them.
      </p>
      <For each={INTEGRATIONS}>
        {(def) => {
          const s = () => summaryFor(def.provider);
          const connected = () => Boolean(s()?.connected);
          return (
            <section
              class="flex items-center gap-3 rounded-lg border border-border bg-bg-2 p-3"
              data-testid={`integration-row-${def.provider}`}
            >
              <span class="shrink-0 text-fg-muted">{def.icon()}</span>
              <div class="min-w-0 flex-1">
                <h3 class="text-[13px] font-semibold tracking-tight">{def.label}</h3>
                <p class="text-[11.5px] text-fg-subtle mt-0.5">
                  <Show
                    when={def.connectable}
                    fallback={
                      <Show when={connected()} fallback={`${def.cli} CLI not detected`}>
                        via {def.cli} CLI
                      </Show>
                    }
                  >
                    <Show when={connected()} fallback="Not connected">
                      Connected
                      <Show when={s()?.user_name}> as @{s()!.user_name}</Show>
                    </Show>
                  </Show>
                </p>
              </div>
              <span
                class="ag-chip text-[11px] shrink-0"
                classList={{ "ag-chip-accent": connected() }}
                data-testid={`integration-status-${def.provider}`}
              >
                {connected() ? "connected" : def.connectable ? "off" : "cli"}
              </span>
              <Show when={def.connectable}>
                <Show
                  when={connected()}
                  fallback={
                    <button
                      type="button"
                      class="ag-btn ag-btn-primary ag-btn-sm shrink-0"
                      disabled={loading() || busy() === def.provider}
                      onClick={() => connect(def.provider)}
                      data-testid={`integration-connect-${def.provider}`}
                    >
                      {busy() === def.provider ? "…" : "Connect"}
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost ag-btn-sm shrink-0 text-danger"
                    disabled={busy() === def.provider}
                    onClick={() => void disconnect(def.provider, def.label)}
                    data-testid={`integration-disconnect-${def.provider}`}
                  >
                    {busy() === def.provider ? "…" : "Disconnect"}
                  </button>
                </Show>
              </Show>
            </section>
          );
        }}
      </For>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg width="1.15em" height="1.15em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

function GitLabIcon() {
  return (
    <svg width="1.15em" height="1.15em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.5 15.32 11.3H8.68L12 21.5ZM3.02 11.3l-1 3.1a.68.68 0 0 0 .25.76L12 21.5 3.02 11.3ZM3.02 11.3h5.66L6.25 3.8a.34.34 0 0 0-.65 0L3.02 11.3ZM20.98 11.3l1 3.1a.68.68 0 0 1-.25.76L12 21.5l8.98-10.2ZM20.98 11.3h-5.66l2.43-7.5a.34.34 0 0 1 .65 0l2.58 7.5Z" />
    </svg>
  );
}

function ClickUpIcon() {
  return (
    <svg width="1.15em" height="1.15em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m2.5 16.3 3.6-2.76c1.9 2.5 3.94 3.66 6.2 3.66 2.26 0 4.24-1.14 6.06-3.62L22 16.32c-2.62 3.58-5.9 5.48-9.7 5.48-3.78 0-7.1-1.9-9.8-5.5ZM12.28 6.02 5.86 11.55 3.9 9.28 12.3 2l8.35 7.28-1.97 2.26-6.4-5.52Z" />
    </svg>
  );
}
