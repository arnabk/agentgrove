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

  /** Keep the menu inside the viewport. The menu is absolutely
   *  positioned relative to the trigger; with long option labels +
   *  `width: max-content` it can spill past the right edge (clipping
   *  labels) or, when opened upward in a short window, past the top.
   *  After it mounts we measure and nudge `left` / cap `max-height` so
   *  it always fits. Pure layout — no behaviour change. */
  function positionMenu() {
    const menu = menuEl;
    const trigger = triggerEl;
    if (!menu || !trigger) return;
    const scroll = menu.querySelector<HTMLElement>(".ag-select-scroll");
    // Reset overrides so each open re-measures from the CSS defaults.
    menu.style.left = "";
    menu.style.right = "";
    if (scroll) scroll.style.maxHeight = "";

    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tr = trigger.getBoundingClientRect();

    // --- Vertical: cap the scroll height to the space on the chosen side
    //     BEFORE measuring width, so the (taller) menu can't push its own
    //     right edge around while we clamp horizontally. ---
    const placeTop = props.placement === "top";
    const space = placeTop
      ? tr.top - margin // room above the trigger
      : vh - tr.bottom - margin; // room below the trigger
    const cap = Math.max(140, Math.min(280, Math.floor(space)));
    if (scroll) scroll.style.maxHeight = `${cap}px`;

    // --- Horizontal: shift left so the right edge stays on-screen. ---
    // Default anchoring is `left: 0` (menu left edge aligns to trigger
    // left). Measure where the right edge lands and pull it back in.
    const mr = menu.getBoundingClientRect();
    const overflowRight = mr.right - (vw - margin);
    if (overflowRight > 0) {
      // Don't push the menu's left past the viewport's left margin.
      const maxShift = Math.max(0, mr.left - margin);
      const shift = Math.min(overflowRight, maxShift);
      menu.style.left = `${-shift}px`;
    }
  }

  createEffect(() => {
    if (open() && menuEl) {
      // Measure after the menu is in the DOM + laid out.
      window.requestAnimationFrame(positionMenu);
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
          {/* Inner scroll container. Keeping the scroll + padding here and
              the border-radius + overflow:hidden on the outer .ag-select-menu
              stops a selected/active option's full-width highlight from
              painting over the menu's rounded corners while scrolling. */}
          <div class="ag-select-scroll">
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
