import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
  /** Where the dropdown menu opens relative to the trigger. Defaults
   *  to `bottom`; pass `top` when the trigger lives near the bottom
   *  of the viewport (e.g. inside the chat composer) so the menu
   *  doesn't get clipped or push container layout. */
  placement?: "top" | "bottom";
}

/** Modern, themed, accessible select. Replaces native <select>. */
export default function Select(props: SelectProps) {
  const [open, setOpen] = createSignal(false);
  const [activeIdx, setActiveIdx] = createSignal(-1);
  let triggerEl: HTMLButtonElement | undefined;
  let menuEl: HTMLDivElement | undefined;

  const selected = () => props.options.find((o) => o.value === props.value);

  function close() {
    setOpen(false);
    setActiveIdx(-1);
  }

  function toggle() {
    if (props.disabled) return;
    if (open()) close();
    else {
      setOpen(true);
      const idx = props.options.findIndex((o) => o.value === props.value);
      setActiveIdx(idx >= 0 ? idx : 0);
    }
  }

  function pick(value: string) {
    props.onChange(value);
    close();
    triggerEl?.focus();
  }

  function onTriggerKey(e: KeyboardEvent) {
    if (props.disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      toggle();
    }
  }

  function onMenuKey(e: KeyboardEvent) {
    if (!open()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      triggerEl?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(props.options.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(props.options.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const idx = activeIdx();
      if (idx >= 0 && idx < props.options.length) {
        pick(props.options[idx]!.value);
      }
    }
  }

  function onDocClick(e: MouseEvent) {
    if (!open()) return;
    const t = e.target as Node | null;
    if (triggerEl && t && triggerEl.contains(t)) return;
    if (menuEl && t && menuEl.contains(t)) return;
    close();
  }

  onMount(() => {
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onMenuKey);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocClick);
    document.removeEventListener("keydown", onMenuKey);
  });

  createEffect(() => {
    if (open() && menuEl) {
      const el = menuEl.querySelector<HTMLElement>(`[data-idx="${activeIdx()}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
  });

  return (
    <div class="ag-select" data-testid={props.testId}>
      <button
        type="button"
        ref={(el) => (triggerEl = el)}
        class="ag-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props.ariaLabel}
        data-open={open() ? "true" : "false"}
        disabled={props.disabled}
        onClick={toggle}
        onKeyDown={onTriggerKey}
      >
        <span class="truncate">
          {selected()?.label ?? (
            <span class="text-fg-subtle">{props.placeholder ?? "Select…"}</span>
          )}
        </span>
        <Caret />
      </button>
      <Show when={open()}>
        <div
          ref={(el) => (menuEl = el)}
          class="ag-select-menu"
          data-placement={props.placement === "top" ? "top" : "bottom"}
          role="listbox"
          aria-label={props.ariaLabel}
        >
          <For each={props.options}>
            {(opt, i) => (
              <div
                class="ag-select-option"
                role="option"
                data-idx={i()}
                data-active={activeIdx() === i() ? "true" : "false"}
                data-selected={opt.value === props.value ? "true" : "false"}
                aria-selected={opt.value === props.value}
                onMouseEnter={() => setActiveIdx(i())}
                onClick={() => pick(opt.value)}
              >
                <span class="truncate">{opt.label}</span>
                <Show when={opt.hint}>
                  <span class="ml-auto text-fg-subtle text-[12px]">{opt.hint}</span>
                </Show>
                <Check />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function Caret() {
  return (
    <svg
      class="ag-select-caret"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function Check() {
  return (
    <svg
      class="ag-select-option-check"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 12l5 5 9-11"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
