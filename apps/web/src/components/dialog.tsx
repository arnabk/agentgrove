import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

/**
 * In-app dialog service. Replaces window.confirm / window.alert / etc
 * with a themed modal that matches the rest of the UI.
 *
 * Usage:
 *
 *   const ok = await confirm({
 *     title: "Delete project",
 *     body: "Remove this project from AgentGrove? Disk is untouched.",
 *     confirmLabel: "Delete",
 *     danger: true,
 *   });
 *
 * The promise resolves to true when the user clicks the confirm button,
 * false when they cancel (button, backdrop, or Escape).
 */

export interface DialogButton {
  label: string;
  value: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export interface DialogRequest {
  title?: string | undefined;
  body?: JSX.Element | undefined;
  buttons: DialogButton[];
  /** Test id for the dialog root. */
  testId?: string | undefined;
  /** Value returned when the user dismisses (Esc, backdrop). Defaults to first non-primary button or "cancel". */
  dismissValue?: string | undefined;
}

interface PendingDialog extends DialogRequest {
  id: number;
  resolve: (value: string) => void;
}

const [queue, setQueue] = createSignal<PendingDialog[]>([]);
let nextId = 1;

function push(req: DialogRequest): Promise<string> {
  return new Promise((resolve) => {
    setQueue((q) => [...q, { ...req, id: nextId++, resolve }]);
  });
}

function popAndResolve(id: number, value: string) {
  setQueue((q) => {
    const target = q.find((d) => d.id === id);
    if (target) target.resolve(value);
    return q.filter((d) => d.id !== id);
  });
}

/** Confirm-style modal. Resolves true/false. */
export async function confirm(opts: {
  title?: string;
  body?: JSX.Element;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  testId?: string;
}): Promise<boolean> {
  const buttons: DialogButton[] = [
    { label: opts.cancelLabel ?? "Cancel", value: "cancel", variant: "ghost" },
    {
      label: opts.confirmLabel ?? "Confirm",
      value: "ok",
      variant: opts.danger ? "danger" : "primary",
    },
  ];
  const result = await push({
    title: opts.title,
    body: opts.body,
    buttons,
    testId: opts.testId ?? "confirm-dialog",
    dismissValue: "cancel",
  });
  return result === "ok";
}

/** Alert-style modal. Returns when the user dismisses. */
export async function alert(opts: {
  title?: string;
  body?: JSX.Element;
  okLabel?: string;
  testId?: string;
}): Promise<void> {
  await push({
    title: opts.title,
    body: opts.body,
    buttons: [{ label: opts.okLabel ?? "OK", value: "ok", variant: "primary" }],
    testId: opts.testId ?? "alert-dialog",
    dismissValue: "ok",
  });
}

/** Mount once near the root. Renders the active dialog (if any). */
export function DialogHost() {
  function onKey(e: KeyboardEvent) {
    const top = queue()[queue().length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      e.preventDefault();
      popAndResolve(top.id, top.dismissValue ?? "cancel");
    } else if (e.key === "Enter") {
      // Trigger the primary/danger button on Enter.
      const primary =
        top.buttons.find((b) => b.variant === "primary") ??
        top.buttons.find((b) => b.variant === "danger");
      if (primary) {
        e.preventDefault();
        popAndResolve(top.id, primary.value);
      }
    }
  }
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  function variantClass(v: DialogButton["variant"]) {
    switch (v) {
      case "primary":
        return "ag-btn ag-btn-primary";
      case "danger":
        return "ag-btn ag-btn-danger !bg-danger/15 !text-danger hover:!bg-danger/25";
      case "secondary":
        return "ag-btn ag-btn-secondary";
      case "ghost":
      default:
        return "ag-btn ag-btn-ghost";
    }
  }

  return (
    <Show when={queue().length > 0}>
      <For each={queue()}>
        {(d, i) => (
          <div
            class="fixed inset-0 z-[100] flex items-center justify-center p-4"
            style={{ "z-index": 100 + i() }}
            role="dialog"
            aria-modal="true"
            aria-label={d.title ?? "Dialog"}
            data-testid={d.testId}
          >
            <div
              class="absolute inset-0 bg-black/60"
              onClick={() => popAndResolve(d.id, d.dismissValue ?? "cancel")}
            />
            <div class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 shadow-2xl overflow-hidden">
              <Show when={d.title}>
                <header class="px-5 py-3.5 border-b border-border">
                  <h2 class="text-[15px] font-semibold tracking-tight">{d.title}</h2>
                </header>
              </Show>
              <Show when={d.body}>
                <div class="px-5 py-4 text-[13.5px] text-fg-muted leading-relaxed whitespace-pre-wrap">
                  {d.body}
                </div>
              </Show>
              <footer class="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
                <For each={d.buttons}>
                  {(b) => (
                    <button
                      type="button"
                      class={variantClass(b.variant)}
                      onClick={() => popAndResolve(d.id, b.value)}
                      data-testid={`dialog-${b.value}`}
                      autofocus={b.variant === "primary" || b.variant === "danger"}
                    >
                      {b.label}
                    </button>
                  )}
                </For>
              </footer>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}
