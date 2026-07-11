import { For, Show } from "solid-js";
import { type CelestialKind, KIND_LABEL, extractVisits, visitsByKind } from "../lib/celestial";

const KINDS: CelestialKind[] = ["star", "planet", "galaxy"];

const KIND_DOT: Record<CelestialKind, string> = {
  star: "bg-yellow-400/80",
  planet: "bg-blue-400/80",
  galaxy: "bg-purple-400/80",
};

interface Props {
  branches: string[];
}

export default function GalaxyLog(props: Props) {
  const visits = () => visitsByKind(extractVisits(props.branches));
  const total = () => visits().star.length + visits().planet.length + visits().galaxy.length;

  return (
    <div class="mt-2 px-2 py-1.5 rounded-md bg-bg-2/50 border border-border/60">
      <div class="text-[10px] uppercase tracking-wider text-fg-subtle font-semibold mb-1">
        Visited
      </div>
      <Show
        when={total() > 0}
        fallback={
          <p class="text-[11px] text-fg-subtle italic">
            No celestial visits yet. Worktree branches named like{" "}
            <code class="font-mono">feature/&lt;star|planet|galaxy&gt;</code> will appear here.
          </p>
        }
      >
        <div class="space-y-1">
          <For each={KINDS}>
            {(kind) => {
              const items = () => visits()[kind];
              const title = () =>
                items()
                  .map((b) => b.display)
                  .join(", ");
              return (
                <Show when={items().length > 0}>
                  <div class="flex items-start gap-1.5 text-[11px]">
                    <span
                      class={`shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${KIND_DOT[kind]}`}
                      aria-hidden="true"
                    />
                    <span class="text-fg-subtle shrink-0">{KIND_LABEL[kind]}:</span>
                    <span class="text-fg truncate" title={title()}>
                      {title()}
                    </span>
                  </div>
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
