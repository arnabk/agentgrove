import { For, Show, createSignal, onMount } from "solid-js";
import { api, type Chat, type ProviderDescriptor } from "../api/client";
import { state } from "../stores/app";
import Select, { type SelectOption } from "./Select";

interface Props {
  /** Project the chat is created under. */
  projectId: string;
  /** Optional worktree to scope the chat to. */
  worktreeId?: string | null;
  /** Suggested default title (e.g. "chat in backend"). */
  defaultTitle: string;
  onCancel: () => void;
  onCreated: (chat: Chat) => void;
}

/**
 * "New chat" dialog. Loads available providers from
 * `GET /api/providers` on mount and lets the user pick:
 *
 *   - title (free text, defaults supplied)
 *   - provider (only available providers selectable; unavailable
 *     ones are shown with their install hint URL)
 *   - model (free text — providers accept aliases like `sonnet` or
 *     full ids; we don't try to enumerate)
 *
 * Closes after `api.createProjectChat` returns and yields the new
 * Chat to the caller.
 */
export default function NewChatDialog(props: Props) {
  const [title, setTitle] = createSignal(props.defaultTitle);
  const [providers, setProviders] = createSignal<ProviderDescriptor[]>([]);
  const [providerId, setProviderId] = createSignal<string>("claude");
  const [model, setModel] = createSignal<string>("sonnet");
  const [loadingProviders, setLoadingProviders] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  /** Re-fetch the active provider's descriptor so the model list
   *  reflects any CLI / upstream changes since the dialog opened
   *  (e.g. the user just installed a new opencode model). Drops
   *  the BE's in-memory cache for that provider before re-detecting. */
  async function refreshActiveProvider() {
    const id = activeProvider()?.id;
    if (!id || refreshing()) return;
    setRefreshing(true);
    try {
      const fresh = await api.refreshProvider(id);
      setProviders((list) => list.map((p) => (p.id === id ? fresh : p)));
      // If the previously-selected model vanished from the list,
      // snap to the provider default so the picker isn't stranded
      // on an unknown value.
      if (fresh.models.length > 0 && !fresh.models.includes(model())) {
        setModel(fresh.default_model);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  onMount(() => {
    // Synchronously use the cached providers if available so we can
    // render optimistically without a flash of loading state.
    if (state.providers && state.providers.length > 0) {
      const userVisible = state.providers.filter((p) => p.id !== "fake");
      const sorted = [...userVisible].sort((a, b) => Number(b.available) - Number(a.available));
      setProviders(sorted);
      const firstAvailable = sorted.find((p) => p.available);
      if (firstAvailable) {
        setProviderId(firstAvailable.id);
        setModel(firstAvailable.default_model);
      }
      // Since we had a cached version, optimistically hide the loader.
      setLoadingProviders(false);
    }

    // Always fetch fresh in the background to catch any recent changes.
    void (async () => {
      try {
        const list = await api.listProviders();
        // Filter out the test-only `fake` provider. The BE keeps it
        // registered for deterministic L4 e2e dispatch, but exposing
        // it in the new-chat dropdown would let real users pick a
        // provider that just echoes the prompt back. The id is
        // stable across builds so a hard-coded filter is safer than
        // a "test-only" flag that could leak through.
        const userVisible = list.filter((p) => p.id !== "fake");
        // Order: available providers first.
        const sorted = [...userVisible].sort((a, b) => Number(b.available) - Number(a.available));
        setProviders(sorted);
        // Only update the selected model if we hadn't already set it
        // (i.e., if cache was empty) or if the current selection is no longer valid.
        if (state.providers.length === 0) {
          const firstAvailable = sorted.find((p) => p.available);
          if (firstAvailable) {
            setProviderId(firstAvailable.id);
            setModel(firstAvailable.default_model);
          }
        }
      } catch (e) {
        if (providers().length === 0) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setLoadingProviders(false);
      }
    })();
  });

  const providerOptions = (): SelectOption[] =>
    providers().map((p) => {
      const opt: SelectOption = {
        value: p.id,
        label: p.available ? p.label : `${p.label} (not installed)`,
      };
      const hint = p.available ? (p.version ? `v${p.version}` : undefined) : "missing CLI";
      if (hint) opt.hint = hint;
      return opt;
    });

  const activeProvider = () => providers().find((p) => p.id === providerId());

  /** Model dropdown options for the active provider. The list is
   *  read from `models` on the descriptor; if the field is missing
   *  (older BE) or empty we return [] so the JSX falls back to a
   *  free-form input.
   *
   *  We annotate each row:
   *    - family aliases (`sonnet`, `opus`, `haiku`, anything without
   *      a date suffix) get a `→ latest` hint so users know it
   *      auto-tracks Anthropic's current release.
   *    - dated releases get the family name as a hint (parsed out
   *      of the id) so the list still reads cleanly when collapsed. */
  const modelOptions = (): SelectOption[] => {
    const provider = activeProvider();
    const list = provider?.models ?? [];
    // Crude but reliable: Claude's dated ids look like
    // `claude-<family>-<version>-<YYYYMMDD>` so any string with an
    // 8-digit suffix is a pin; everything else is an alias.
    const datedRe = /-(\d{8})$/;
    return list.map((m): SelectOption => {
      const match = datedRe.exec(m);
      if (match) {
        // Family hint = everything between `claude-` and the version
        // marker, e.g. "claude-sonnet-4-5-20250929" → "sonnet 4.5".
        const inner = m
          .replace(/^claude-/, "")
          .replace(/-\d{8}$/, "")
          .split("-");
        const family = inner.shift() ?? "";
        const version = inner.join(".");
        return {
          value: m,
          label: m,
          hint: version ? `${family} ${version}` : family,
        };
      }
      return { value: m, label: m, hint: "→ latest" };
    });
  };

  function onPickProvider(id: string) {
    setProviderId(id);
    const p = providers().find((x) => x.id === id);
    if (p) setModel(p.default_model);
  }

  async function submit(ev: SubmitEvent) {
    ev.preventDefault();
    const t = title().trim();
    const m = model().trim();
    if (!t) {
      setErr("Title is required.");
      return;
    }
    if (!m) {
      setErr("Model is required.");
      return;
    }
    const provider = activeProvider();
    if (!provider) {
      setErr("Pick a provider.");
      return;
    }
    if (!provider.available) {
      setErr(`${provider.label} CLI is not installed. See ${provider.install_hint}`);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const body: {
        title: string;
        provider: string;
        model: string;
        worktree_id?: string;
      } = { title: t, provider: provider.id, model: m };
      if (props.worktreeId) body.worktree_id = props.worktreeId;
      const created = await api.createProjectChat(props.projectId, body);
      props.onCreated(created);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New chat"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="new-chat-dialog"
    >
      <div class="absolute inset-0 bg-black/60" onClick={() => !busy() && props.onCancel()} />
      <form
        onSubmit={submit}
        class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 p-6 shadow-2xl"
      >
        <h3 class="text-[15px] font-semibold mb-1">New chat</h3>
        <p class="text-[13px] text-fg-muted mb-5">
          AgentGrove launches the selected provider's installed CLI inside this{" "}
          {props.worktreeId ? "worktree" : "project"}. Authentication is whatever your CLI is
          already set up for.
        </p>

        <label class="block text-[12px] font-medium text-fg-muted mb-1.5">Title</label>
        <input
          class="ag-input mb-4"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          data-testid="new-chat-title"
          autofocus
        />

        <label class="block text-[12px] font-medium text-fg-muted mb-1.5">Provider</label>
        <Show
          when={!loadingProviders()}
          fallback={
            <div
              class="ag-input mb-4 !cursor-default opacity-60"
              data-testid="new-chat-providers-loading"
            >
              Loading providers…
            </div>
          }
        >
          <div class="mb-4">
            <Select
              value={providerId()}
              options={providerOptions()}
              onChange={onPickProvider}
              ariaLabel="Provider"
              testId="new-chat-provider"
            />
            <Show when={activeProvider() && !activeProvider()!.available}>
              <p class="mt-1.5 text-[11.5px] text-fg-subtle">
                {activeProvider()!.label} isn't installed. See{" "}
                <a
                  class="underline hover:text-accent"
                  href={activeProvider()!.install_hint}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  install instructions
                </a>
                .
              </p>
            </Show>
          </div>
        </Show>

        <div class="flex items-center justify-between mb-1.5">
          <label class="text-[12px] font-medium text-fg-muted">Model</label>
          <Show when={activeProvider()}>
            <button
              type="button"
              class="ag-btn ag-btn-ghost ag-btn-sm inline-flex items-center gap-1 text-[11px]"
              onClick={() => void refreshActiveProvider()}
              disabled={refreshing()}
              title="Refresh model list"
              data-testid="new-chat-refresh-models"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                width="1em"
                height="1em"
                aria-hidden="true"
                classList={{ "ag-spin": refreshing() }}
              >
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                <path d="M3 21v-5h5" />
              </svg>
              {refreshing() ? "Refreshing…" : "Refresh"}
            </button>
          </Show>
        </div>
        {/*
          Themed dropdown of the active provider's curated model
          aliases. If the BE happens to return an empty list (shouldn't
          today, but the DTO field is `Vec<String>` so it's possible
          for future providers), we fall back to a free-form input so
          the dialog never deadlocks the user.

          For power-user model ids that aren't in the curated list,
          the per-chat settings dialog still accepts free-form text
          after creation — keeping this picker tight so the common
          case (alias-only) doesn't lose to a wall of release tags.
        */}
        <Show
          when={modelOptions().length > 0}
          fallback={
            <input
              class="ag-input font-mono mb-1.5"
              value={model()}
              onInput={(e) => setModel(e.currentTarget.value)}
              data-testid="new-chat-model"
              placeholder="sonnet"
            />
          }
        >
          <div data-testid="new-chat-model">
            <Select
              value={model()}
              options={modelOptions()}
              onChange={(v) => setModel(v)}
              ariaLabel="Model"
              testId="new-chat-model-select"
            />
          </div>
        </Show>
        <p class="text-[11px] text-fg-subtle mb-5">
          Provider aliases (e.g. <code class="font-mono">sonnet</code>,{" "}
          <code class="font-mono">opus</code>) resolve to the current release. Power users can paste
          a full model id later from per-chat settings.
        </p>

        <Show when={err()}>
          <p class="mb-4 text-[12px] text-danger" data-testid="new-chat-error">
            {err()}
          </p>
        </Show>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="ag-btn ag-btn-ghost"
            onClick={() => props.onCancel()}
            disabled={busy()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="ag-btn ag-btn-primary"
            disabled={busy() || loadingProviders()}
            data-testid="new-chat-submit"
          >
            {busy() ? "Creating…" : "Create chat"}
          </button>
        </div>

        <Show when={providers().length > 0}>
          <details class="mt-4 text-[11.5px] text-fg-subtle">
            <summary class="cursor-pointer">All providers</summary>
            <ul class="mt-2 space-y-1 font-mono">
              <For each={providers()}>
                {(p) => (
                  <li class="flex justify-between gap-2">
                    <span>
                      {p.label} <span class="text-fg-subtle">({p.id})</span>
                    </span>
                    <span class={p.available ? "text-success" : "text-fg-subtle"}>
                      {p.available ? `v${p.version ?? "?"}` : "not installed"}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </details>
        </Show>
      </form>
    </div>
  );
}
