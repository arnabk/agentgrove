import { For, createSignal } from "solid-js";

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

export default function ToastHost() {
  return (
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
      <For each={toasts()}>
        {(toast) => (
          <div
            class="pointer-events-auto rounded-lg border border-border bg-bg-1 shadow-lg px-4 py-3 text-[13px] animate-[slideInRight_0.25s_ease-out]"
            data-testid={`toast-${toast.id}`}
          >
            <div class="flex items-start gap-2">
              <div class="flex-1 min-w-0">
                <p class="font-semibold text-fg truncate">{toast.title}</p>
                <p class="text-fg-muted text-[12px] mt-0.5">{toast.message}</p>
              </div>
              <button
                type="button"
                class="shrink-0 text-fg-subtle hover:text-fg text-[11px]"
                onClick={() => dismissToast(toast.id)}
              >
                ✕
              </button>
            </div>
            {toast.action && (
              <button
                type="button"
                class="mt-2 text-accent text-[12px] font-medium hover:underline"
                onClick={() => {
                  toast.action!.onClick();
                  dismissToast(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </For>
    </div>
  );
}
