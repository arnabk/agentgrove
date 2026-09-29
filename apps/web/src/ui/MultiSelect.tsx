import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { SelectOption } from "@/ui/Select";

interface MultiSelectProps {
  /** Currently-selected values. */
  values: string[];
  options: SelectOption[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
  placement?: "top" | "bottom";
}

/** Modern, themed, accessible multi-select. Shares the `.ag-select-*`
 *  look with {@link Select} but toggles values (menu stays open) and
 *  shows a "N selected" summary in the trigger. */
export default function MultiSelect(props: MultiSelectProps) {
  const [open, setOpen] = createSignal(false);
  const [activeIdx, setActiveIdx] = createSignal(-1);
  let triggerEl: HTMLButtonElement | undefined;
  let menuEl: HTMLDivElement | undefined;

  const chosen = () => new Set(props.values);

  const summary = () => {
    const set = chosen();
    const picked = props.options.filter((o) => set.has(o.value));
    if (picked.length === 0) return null;
    if (picked.length === 1) return picked[0]!.label;
    return `${picked.length} selected`;
  };

  function close() {
    setOpen(false);
    setActiveIdx(-1);
  }

  function toggleMenu() {
    if (props.disabled) return;
    if (open()) close();
    else {
      setOpen(true);
      setActiveIdx(0);
    }
  }

  function toggleValue(value: string) {
    const set = chosen();
    if (set.has(value)) set.delete(value);
    else set.add(value);
    props.onChange([...set]);
  }

  function onTriggerKey(e: KeyboardEvent) {
    if (props.disabled) return;
    // While the menu is open, Enter/Space are owned by onMenuKey (they
    // toggle the active option and keep the menu open for multi-pick).
    // Only the trigger's *closed* state should open it; otherwise this
    // handler and the document keydown listener both fire on the same
    // Enter — toggling a value AND immediately closing the menu.
    if (open()) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      toggleMenu();
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
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const idx = activeIdx();
      if (idx >= 0 && idx < props.options.length) toggleValue(props.options[idx]!.value);
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

  /** Keep the menu inside the viewport (mirrors Select.positionMenu). */
  function positionMenu() {
    const menu = menuEl;
    const trigger = triggerEl;
    if (!menu || !trigger) return;
    const scroll = menu.querySelector<HTMLElement>(".ag-select-scroll");
    menu.style.left = "";
    menu.style.right = "";
    if (scroll) scroll.style.maxHeight = "";

    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tr = trigger.getBoundingClientRect();

    const placeTop = props.placement === "top";
    const space = placeTop ? tr.top - margin : vh - tr.bottom - margin;
    const cap = Math.max(140, Math.min(280, Math.floor(space)));
    if (scroll) scroll.style.maxHeight = `${cap}px`;

    const mr = menu.getBoundingClientRect();
    const overflowRight = mr.right - (vw - margin);
    if (overflowRight > 0) {
      const maxShift = Math.max(0, mr.left - margin);
      const shift = Math.min(overflowRight, maxShift);
      menu.style.left = `${-shift}px`;
    }
  }

  createEffect(() => {
    if (open() && menuEl) window.requestAnimationFrame(positionMenu);
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
        onClick={toggleMenu}
        onKeyDown={onTriggerKey}
      >
        <span class="truncate">
          {summary() ?? <span class="text-fg-subtle">{props.placeholder ?? "Select…"}</span>}
        </span>
        <Caret />
      </button>
      <Show when={open()}>
        <div
          ref={(el) => (menuEl = el)}
          class="ag-select-menu"
          data-placement={props.placement === "top" ? "top" : "bottom"}
          role="listbox"
          aria-multiselectable="true"
          aria-label={props.ariaLabel}
        >
          <div class="ag-select-scroll">
            <For each={props.options}>
              {(opt, i) => {
                const isSel = () => chosen().has(opt.value);
                return (
                  <div
                    class="ag-select-option"
                    role="option"
                    data-idx={i()}
                    data-active={activeIdx() === i() ? "true" : "false"}
                    data-selected={isSel() ? "true" : "false"}
                    aria-selected={isSel()}
                    onMouseEnter={() => setActiveIdx(i())}
                    onClick={() => toggleValue(opt.value)}
                  >
                    <span class="truncate">{opt.label}</span>
                    <span class="ag-select-hint text-fg-subtle text-[12px]">{opt.hint ?? ""}</span>
                    <Check />
                  </div>
                );
              }}
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
