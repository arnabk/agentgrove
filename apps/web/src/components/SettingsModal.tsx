import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
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
 * Global settings modal. Theme + UI/mono font + font size for now.
 * Persisted via PUT /api/settings.
 */
export default function SettingsModal() {


  // Local working copy so we apply only on change, not on every keystroke
  // (Solid stores update reactively; we route writes through saveSettings).
  const [theme, setTheme] = createSignal(state.themeId);
  const [uiFont, setUiFont] = createSignal(state.settings.ui_font ?? FONT_FAMILY_PRESETS[0]!.value);
  const [monoFont, setMonoFont] = createSignal(
    state.settings.mono_font ?? MONO_FAMILY_PRESETS[0]!.value,
  );
  const [size, setSize] = createSignal(state.settings.font_size ?? 15);

  // Sync local state with store whenever the modal opens.
  createEffect(() => {
    if (settingsOpen()) {
      setTheme(state.themeId);
      setUiFont(state.settings.ui_font ?? FONT_FAMILY_PRESETS[0]!.value);
      setMonoFont(state.settings.mono_font ?? MONO_FAMILY_PRESETS[0]!.value);
      setSize(state.settings.font_size ?? 15);
    }
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") setSettingsOpen(false);
  }
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

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
        <div
          class="relative w-full max-w-lg rounded-xl border border-border bg-bg-1 shadow-2xl overflow-hidden"
        >
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

          <div class="px-5 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
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
                <span
                  class="ag-chip font-mono"
                  data-testid="settings-font-size-value"
                >
                  {size()}px
                </span>
              </div>
            </Row>
          </div>

          <footer class="flex items-center justify-between px-5 py-3 border-t border-border">
            <button
              class="ag-btn ag-btn-ghost"
              onClick={reset}
              data-testid="settings-reset"
            >
              Reset to defaults
            </button>
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
