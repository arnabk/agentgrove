import { For, Show, createSignal, onMount } from "solid-js";

export interface ToastItem {
  id: string;
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
  timeoutMs?: number;
}

const [toasts, setToasts] = createSignal<ToastItem[]>([]);

export function pushToast(item: Omit<ToastItem, "id">) {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const full: ToastItem = { id, ...item };
  setToasts((prev) => [...prev, full]);
  const ms = item.timeoutMs ?? 8000;
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: string) {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

function ToastCard(props: { toast: ToastItem }) {
  const [visible, setVisible] = createSignal(false);
  const ms = props.toast.timeoutMs ?? 8000;

  onMount(() => {
    requestAnimationFrame(() => setVisible(true));
  });

  return (
    <div
      class="pointer-events-auto rounded-xl border border-border bg-bg-1/95 backdrop-blur-sm shadow-xl transition-all duration-300 ease-out overflow-hidden"
      classList={{
        "translate-x-0 opacity-100": visible(),
        "translate-x-full opacity-0": !visible(),
      }}
      data-testid={`toast-${props.toast.id}`}
    >
      <div class="px-4 py-3">
        <div class="flex items-start gap-3">
          <span class="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-success/20 text-success flex items-center justify-center text-[11px]">
            ✓
          </span>
          <div class="flex-1 min-w-0">
            <p class="font-semibold text-fg text-[13px] truncate">{props.toast.title}</p>
            <p class="text-fg-muted text-[12px] mt-0.5 leading-snug">{props.toast.message}</p>
            <Show when={props.toast.action}>
              <button
                type="button"
                class="mt-1.5 text-accent text-[12px] font-medium hover:underline"
                onClick={() => {
                  props.toast.action!.onClick();
                  dismissToast(props.toast.id);
                }}
              >
                {props.toast.action!.label}
              </button>
            </Show>
          </div>
          <button
            type="button"
            class="shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-bg-3 transition-colors text-[11px]"
            onClick={() => dismissToast(props.toast.id)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
      <div
        class="h-[2px] bg-accent/40 origin-left"
        style={`animation: ag-toast-progress ${ms}ms linear forwards`}
      />
    </div>
  );
}

export default function ToastHost() {
  return (
    <div class="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 w-80 pointer-events-none">
      <For each={toasts()}>{(toast) => <ToastCard toast={toast} />}</For>
    </div>
  );
}
