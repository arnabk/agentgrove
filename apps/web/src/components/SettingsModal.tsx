import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { produce } from "solid-js/store";
import { api, type PromptTemplate } from "../api/client";
import {
  FONT_FAMILY_PRESETS,
  FONT_SIZES,
  MONO_FAMILY_PRESETS,
  saveSettings,
  setSettingsOpen,
  settingsOpen,
  state,
} from "../stores/app";
import Select from "./Select";

/**
 * Tabbed global settings modal.
 *
 *   - **Appearance** — theme, UI/mono fonts, font size.
 *   - **Prompts** — reusable prompt templates the chat input can
 *     insert via the `/` picker. Stored on the BE inside the
 *     settings JSON file.
 *
 * Subsequent tabs (Agents, Keybindings, ...) plug in by adding a
 * `Tab` entry below.
 */

type TabId = "appearance" | "prompts" | "providers";
const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "prompts", label: "Prompts" },
  { id: "providers", label: "Providers" },
];

export default function SettingsModal() {
  const [tab, setTab] = createSignal<TabId>("appearance");

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") setSettingsOpen(false);
  }
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <Show when={settingsOpen()}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-modal"
      >
        <div
          class="absolute inset-0 bg-black/60"
          onClick={() => setSettingsOpen(false)}
        />
        <div class="relative w-full max-w-2xl rounded-xl border border-border bg-bg-1 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
          <header class="flex items-center justify-between px-5 py-3 border-b border-border">
            <h2 class="text-[15px] font-semibold tracking-tight">Settings</h2>
            <button
              class="ag-btn ag-btn-ghost ag-btn-icon"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close"
              data-testid="settings-close"
            >
              <XIcon />
            </button>
          </header>

          {/* Tab strip */}
          <nav
            class="flex gap-1 px-4 pt-3 border-b border-border bg-bg-1"
            data-testid="settings-tabs"
          >
            <For each={TABS}>
              {(t) => (
                <button
                  class="ag-btn ag-btn-ghost !py-1.5 !px-3 text-[12.5px] rounded-b-none"
                  classList={{ "!bg-bg-3 !text-fg": tab() === t.id }}
                  onClick={() => setTab(t.id)}
                  data-testid={`settings-tab-${t.id}`}
                >
                  {t.label}
                </button>
              )}
            </For>
          </nav>

          <div class="px-5 py-5 overflow-y-auto flex-1">
            <Show when={tab() === "appearance"}>
              <AppearanceTab />
            </Show>
            <Show when={tab() === "prompts"}>
              <PromptsTab />
            </Show>
            <Show when={tab() === "providers"}>
              <ProvidersTab />
            </Show>
          </div>

          <footer class="flex items-center justify-end px-5 py-3 border-t border-border">
            <button
              class="ag-btn ag-btn-primary"
              onClick={() => setSettingsOpen(false)}
              data-testid="settings-done"
            >
              Done
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

function AppearanceTab() {
  const [theme, setTheme] = createSignal(state.themeId);
  const [uiFont, setUiFont] = createSignal(
    state.settings.ui_font ?? FONT_FAMILY_PRESETS[0]!.value,
  );
  const [monoFont, setMonoFont] = createSignal(
    state.settings.mono_font ?? MONO_FAMILY_PRESETS[0]!.value,
  );
  const [size, setSize] = createSignal(state.settings.font_size ?? 15);

  createEffect(() => {
    if (settingsOpen()) {
      setTheme(state.themeId);
      setUiFont(state.settings.ui_font ?? FONT_FAMILY_PRESETS[0]!.value);
      setMonoFont(state.settings.mono_font ?? MONO_FAMILY_PRESETS[0]!.value);
      setSize(state.settings.font_size ?? 15);
    }
  });

  async function onTheme(v: string) {
    setTheme(v);
    await saveSettings({ theme: v });
  }
  async function onUiFont(v: string) {
    setUiFont(v);
    await saveSettings({ ui_font: v });
  }
  async function onMonoFont(v: string) {
    setMonoFont(v);
    await saveSettings({ mono_font: v });
  }
  async function onSize(v: number) {
    setSize(v);
    await saveSettings({ font_size: v });
  }
  async function reset() {
    await saveSettings({
      theme: "dark-default",
      ui_font: FONT_FAMILY_PRESETS[0]!.value,
      mono_font: MONO_FAMILY_PRESETS[0]!.value,
      font_size: 15,
    });
    setTheme("dark-default");
    setUiFont(FONT_FAMILY_PRESETS[0]!.value);
    setMonoFont(MONO_FAMILY_PRESETS[0]!.value);
    setSize(15);
  }

  return (
    <div class="space-y-5">
      <Row label="Theme" hint="Color palette for the app shell.">
        <Select
          value={theme()}
          onChange={(v) => onTheme(v)}
          ariaLabel="Theme"
          testId="settings-theme"
          options={state.themes.map((t) => ({ value: t.id, label: t.name }))}
        />
      </Row>

      <Row label="UI font" hint="Used for menus, labels, dialogs.">
        <Select
          value={uiFont()}
          onChange={(v) => onUiFont(v)}
          ariaLabel="UI font"
          testId="settings-ui-font"
          options={FONT_FAMILY_PRESETS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </Row>

      <Row label="Code font" hint="Used in editor, diff, and terminal.">
        <Select
          value={monoFont()}
          onChange={(v) => onMonoFont(v)}
          ariaLabel="Code font"
          testId="settings-mono-font"
          options={MONO_FAMILY_PRESETS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </Row>

      <Row label="Font size" hint="Base size for UI text, in pixels.">
        <div class="flex items-center gap-2">
          <input
            type="range"
            min={FONT_SIZES[0]}
            max={FONT_SIZES[FONT_SIZES.length - 1]}
            step="1"
            value={size()}
            onInput={(e) => onSize(Number(e.currentTarget.value))}
            class="flex-1 accent-[var(--ag-accent)]"
            data-testid="settings-font-size"
          />
          <span class="ag-chip font-mono" data-testid="settings-font-size-value">
            {size()}px
          </span>
        </div>
      </Row>

      <div class="pt-2">
        <button
          class="ag-btn ag-btn-ghost"
          onClick={reset}
          data-testid="settings-reset"
        >
          Reset appearance to defaults
        </button>
      </div>
    </div>
  );
}

function PromptsTab() {
  /** Working copy keyed by id so reordering / per-row edits don't
   *  fight with the array's React-style identity tracking. We persist
   *  on every commit (blur / explicit Save). */
  const [drafts, setDrafts] = createSignal<PromptTemplate[]>(
    state.settings.prompts ?? [],
  );

  // Re-pull from store whenever the modal reopens.
  createEffect(() => {
    if (settingsOpen()) setDrafts(state.settings.prompts ?? []);
  });

  async function persist(next: PromptTemplate[]) {
    setDrafts(next);
    await saveSettings({ prompts: next });
  }

  async function addPrompt() {
    const next: PromptTemplate = {
      id: `pt-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      name: "New prompt",
      body: "",
    };
    await persist([...drafts(), next]);
  }

  async function updatePrompt(id: string, patch: Partial<PromptTemplate>) {
    const next = drafts().map((p) =>
      p.id === id ? { ...p, ...patch } : p,
    );
    await persist(next);
  }

  async function deletePrompt(id: string) {
    await persist(drafts().filter((p) => p.id !== id));
  }

  async function move(id: string, dir: -1 | 1) {
    const arr = drafts();
    const idx = arr.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    const next = [...arr];
    const [item] = next.splice(idx, 1);
    next.splice(newIdx, 0, item!);
    await persist(next);
  }

  return (
    <div class="space-y-4" data-testid="settings-prompts">
      <p class="text-[12.5px] text-fg-muted">
        Reusable prompt templates. Pick one from the chat input's{" "}
        <code class="font-mono">/</code> menu to insert its body at the
        cursor.
      </p>

      <Show
        when={drafts().length > 0}
        fallback={
          <p
            class="text-[12.5px] text-fg-subtle italic"
            data-testid="settings-prompts-empty"
          >
            No saved prompts yet. Click <strong>Add prompt</strong> to
            create one.
          </p>
        }
      >
        <ul class="space-y-3">
          <For each={drafts()}>
            {(p, i) => (
              <li
                class="rounded-lg border border-border bg-bg-2 p-3 space-y-2"
                data-testid={`prompt-row-${p.id}`}
              >
                <div class="flex items-center gap-2">
                  <input
                    class="ag-input flex-1"
                    value={p.name}
                    placeholder="Prompt name"
                    onInput={(e) =>
                      setDrafts(
                        produce((d) => {
                          const t = d.find((x) => x.id === p.id);
                          if (t) t.name = e.currentTarget.value;
                        }),
                      )
                    }
                    onBlur={(e) =>
                      void updatePrompt(p.id, {
                        name: e.currentTarget.value,
                      })
                    }
                    data-testid={`prompt-name-${p.id}`}
                  />
                  <button
                    class="ag-btn ag-btn-ghost ag-btn-sm"
                    onClick={() => void move(p.id, -1)}
                    disabled={i() === 0}
                    title="Move up"
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    class="ag-btn ag-btn-ghost ag-btn-sm"
                    onClick={() => void move(p.id, 1)}
                    disabled={i() === drafts().length - 1}
                    title="Move down"
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    class="ag-btn ag-btn-ghost ag-btn-sm text-danger"
                    onClick={() => void deletePrompt(p.id)}
                    title="Delete prompt"
                    aria-label={`Delete prompt ${p.name}`}
                    data-testid={`prompt-delete-${p.id}`}
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  class="ag-input resize-y min-h-[5em]"
                  rows="3"
                  value={p.body}
                  placeholder="Prompt body"
                  onInput={(e) =>
                    setDrafts(
                      produce((d) => {
                        const t = d.find((x) => x.id === p.id);
                        if (t) t.body = e.currentTarget.value;
                      }),
                    )
                  }
                  onBlur={(e) =>
                    void updatePrompt(p.id, {
                      body: e.currentTarget.value,
                    })
                  }
                  data-testid={`prompt-body-${p.id}`}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>

      <button
        class="ag-btn ag-btn-primary"
        onClick={() => void addPrompt()}
        data-testid="settings-prompts-add"
      >
        + Add prompt
      </button>
    </div>
  );
}

/**
 * Providers tab — per-provider config for HTTP-API providers.
 *
 * Today only 9router uses this surface. The form lets the user
 * paste a base URL + (optionally) an API key + a default model;
 * the key is sent to the BE which encrypts at rest. The key is
 * never echoed back, so the form starts with the key field empty
 * even when one is already stored — `has_api_key` shows whether
 * one is present.
 *
 * When more HTTP-API providers land (OpenAI direct, Anthropic
 * direct, etc.) duplicate the `ProviderForm` block for each id —
 * the wire shape is identical.
 */
function ProvidersTab() {
  return (
    <div class="space-y-6" data-testid="settings-providers-tab">
      <ProviderForm
        providerId="9router"
        label="9router"
        installHint="Install with `npm install -g 9router`, run `9router`, then copy the API key from http://localhost:3000."
        defaultBaseUrl="http://localhost:20128/v1"
        defaultModelPlaceholder="free-combo"
      />
    </div>
  );
}

function ProviderForm(props: {
  providerId: string;
  label: string;
  installHint: string;
  defaultBaseUrl: string;
  defaultModelPlaceholder: string;
}) {
  const [baseUrl, setBaseUrl] = createSignal(props.defaultBaseUrl);
  const [defaultModel, setDefaultModel] = createSignal("");
  const [apiKey, setApiKey] = createSignal("");
  const [hasKey, setHasKey] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [savedTick, setSavedTick] = createSignal(0);

  // Hydrate from BE on mount. 404 means no config yet — leave the
  // defaults in place so the user just has to paste a key.
  onMount(() => {
    void (async () => {
      try {
        const cfg = await api.getProviderConfig(props.providerId);
        setBaseUrl(cfg.base_url);
        setDefaultModel(cfg.default_model ?? "");
        setHasKey(cfg.has_api_key);
      } catch {
        // 404 / network — keep defaults.
      }
    })();
  });

  async function save() {
    if (!baseUrl().trim()) {
      setErr("Base URL is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: {
        base_url: string;
        default_model?: string;
        api_key?: string;
      } = { base_url: baseUrl().trim() };
      if (defaultModel().trim()) body.default_model = defaultModel().trim();
      // Only send api_key if the user typed something. Empty +
      // not-touched should leave the existing key untouched. The
      // user clears the key explicitly via the "Forget" button.
      if (apiKey().length > 0) body.api_key = apiKey();
      const cfg = await api.putProviderConfig(props.providerId, body);
      setHasKey(cfg.has_api_key);
      setApiKey(""); // never keep the plaintext in the form
      setSavedTick((t) => t + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    setErr(null);
    try {
      await api.putProviderConfig(props.providerId, {
        base_url: baseUrl().trim() || props.defaultBaseUrl,
        api_key: "", // empty = clear
      });
      setHasKey(false);
      setApiKey("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      class="rounded-lg border border-border bg-bg-2 p-4 space-y-3"
      data-testid={`provider-form-${props.providerId}`}
    >
      <header class="flex items-center justify-between">
        <h3 class="text-[13.5px] font-semibold">{props.label}</h3>
        <Show
          when={hasKey()}
          fallback={
            <span class="ag-chip text-[11px]">no key</span>
          }
        >
          <span class="ag-chip ag-chip-accent text-[11px]">configured</span>
        </Show>
      </header>
      <p class="text-[11.5px] text-fg-subtle">{props.installHint}</p>

      <label class="block text-[12px] font-medium text-fg-muted">
        Base URL
      </label>
      <input
        class="ag-input font-mono text-[12.5px]"
        placeholder={props.defaultBaseUrl}
        value={baseUrl()}
        onInput={(e) => setBaseUrl(e.currentTarget.value)}
        disabled={busy()}
        data-testid={`provider-${props.providerId}-base-url`}
      />

      <label class="block text-[12px] font-medium text-fg-muted">
        Default model
      </label>
      <input
        class="ag-input font-mono text-[12.5px]"
        placeholder={props.defaultModelPlaceholder}
        value={defaultModel()}
        onInput={(e) => setDefaultModel(e.currentTarget.value)}
        disabled={busy()}
        data-testid={`provider-${props.providerId}-default-model`}
      />

      <label class="block text-[12px] font-medium text-fg-muted">
        API key
      </label>
      <input
        type="password"
        autocomplete="off"
        class="ag-input font-mono text-[12.5px]"
        placeholder={hasKey() ? "•••••••• (leave blank to keep)" : "sk-..."}
        value={apiKey()}
        onInput={(e) => setApiKey(e.currentTarget.value)}
        disabled={busy()}
        data-testid={`provider-${props.providerId}-api-key`}
      />
      <p class="text-[11px] text-fg-subtle">
        Stored encrypted at rest under{" "}
        <code class="font-mono">&lt;state_dir&gt;/agentgrove.sqlite</code>{" "}
        with a machine-bound key at{" "}
        <code class="font-mono">&lt;state_dir&gt;/secrets.key</code>.
      </p>

      <Show when={err()}>
        <p class="text-[12px] text-danger" data-testid={`provider-${props.providerId}-error`}>
          {err()}
        </p>
      </Show>

      <div class="flex items-center gap-2 pt-1">
        <button
          type="button"
          class="ag-btn ag-btn-primary"
          onClick={() => void save()}
          disabled={busy()}
          data-testid={`provider-${props.providerId}-save`}
        >
          {busy() ? "Saving…" : "Save"}
        </button>
        <Show when={hasKey()}>
          <button
            type="button"
            class="ag-btn ag-btn-ghost"
            onClick={() => void forget()}
            disabled={busy()}
            data-testid={`provider-${props.providerId}-forget`}
          >
            Forget key
          </button>
        </Show>
        <Show when={savedTick() > 0}>
          <span class="text-[11.5px] text-accent">Saved.</span>
        </Show>
      </div>
    </section>
  );
}

function Row(props: {
  label: string;
  hint?: string;
  children: import("solid-js").JSX.Element;
}) {
  return (
    <div>
      <label class="block text-[12.5px] font-medium text-fg mb-1">{props.label}</label>
      {props.hint && (
        <p class="text-[11.5px] text-fg-subtle mb-2">{props.hint}</p>
      )}
      {props.children}
    </div>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}
