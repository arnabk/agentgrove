import { switchShell } from "@/core/lib/shellSelect";

/**
 * Mobile shell. Placeholder: the shell selector and its CSS scoping
 * land first so the desktop path is provably untouched. The drawer,
 * tab bar and views arrive in the following commits.
 */
export default function MobileApp() {
  return (
    <div
      class="flex h-full w-full flex-col items-center justify-center gap-4 bg-bg px-6 text-center"
      data-testid="mobile-app"
    >
      <p class="text-[15px] font-semibold text-fg">AgentGrove mobile</p>
      <p class="text-[13px] text-fg-muted">This shell is still being built.</p>
      <button
        type="button"
        class="ag-btn ag-btn-ghost ag-btn-sm"
        onClick={() => switchShell("desktop")}
        data-testid="mobile-switch-to-desktop"
      >
        Use the desktop version
      </button>
    </div>
  );
}
