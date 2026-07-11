import { For, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { ALL_CELESTIAL, extractVisits, type CelestialKind } from "../lib/celestial";

/* global CanvasRenderingContext2D */

interface Props {
  branches: string[];
  onClose: () => void;
}

const KIND_COLOR: Record<CelestialKind, string> = {
  star: "#fbbf24",
  planet: "#60a5fa",
  galaxy: "#c084fc",
};

const KIND_SIZE: Record<CelestialKind, number> = {
  star: 5,
  planet: 4,
  galaxy: 7,
};

const KIND_LABEL: Record<CelestialKind, string> = {
  star: "Stars",
  planet: "Planets",
  galaxy: "Galaxies",
};

const KINDS: CelestialKind[] = ["star", "planet", "galaxy"];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function bodyPosition(name: string, width: number, height: number) {
  const h = hashString(name);
  const maxRadius = Math.min(width, height) * 0.42;
  const r = Math.sqrt(h / 0xffffffff) * maxRadius;
  const angle = (h / 0xffffffff) * Math.PI * 2 + r * 0.03;
  return {
    x: width / 2 + r * Math.cos(angle),
    y: height / 2 + r * Math.sin(angle),
  };
}

export default function GalaxyMapDialog(props: Props) {
  const visited = createMemo(() => {
    const visits = extractVisits(props.branches);
    return new Set(visits.map((b) => b.display));
  });

  const counts = createMemo(() => {
    const v = visited();
    const out = { star: 0, planet: 0, galaxy: 0 };
    for (const body of ALL_CELESTIAL) {
      if (v.has(body.display)) out[body.kind]++;
    }
    return out;
  });

  const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement>();

  const draw = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width * dpr, height * dpr);
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#0b0c15";
    ctx.fillRect(0, 0, width, height);

    // Procedural background stars (3000 tiny dots)
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    for (let i = 0; i < 3000; i++) {
      ctx.beginPath();
      ctx.arc(rnd() * width, rnd() * height, rnd() * 1.2 + 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    const v = visited();

    // Collect visited positions for constellation lines
    const visitedPositions: { x: number; y: number }[] = [];
    for (const body of ALL_CELESTIAL) {
      if (v.has(body.display)) {
        visitedPositions.push(bodyPosition(body.display, width, height));
      }
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    const connectRadius = Math.min(width, height) * 0.18;
    for (let i = 0; i < visitedPositions.length; i++) {
      for (let j = i + 1; j < visitedPositions.length; j++) {
        const a = visitedPositions[i]!;
        const b = visitedPositions[j]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy < connectRadius * connectRadius) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // All celestial bodies
    for (const body of ALL_CELESTIAL) {
      const isVisited = v.has(body.display);
      const pos = bodyPosition(body.display, width, height);
      const color = KIND_COLOR[body.kind];
      const size = isVisited ? KIND_SIZE[body.kind] : 1.5;

      if (isVisited) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, size * 3, 0, Math.PI * 2);
        ctx.fillStyle = `${color}20`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
      ctx.fillStyle = isVisited ? color : `${color}40`;
      ctx.fill();

      if (isVisited) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
        ctx.font =
          '11px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = "left";
        ctx.fillText(body.display, pos.x + size + 4, pos.y + 3);
      }
    }
  };

  const resizeAndDraw = () => {
    const canvas = canvasRef();
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(ctx, rect.width, rect.height);
  };

  onMount(() => {
    resizeAndDraw();
    window.addEventListener("resize", resizeAndDraw);
    return () => window.removeEventListener("resize", resizeAndDraw);
  });

  createEffect(() => {
    visited();
    resizeAndDraw();
  });

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="w-full max-w-5xl h-[85vh] rounded-xl border border-border bg-bg-1 shadow-2xl flex flex-col overflow-hidden">
        <header class="h-12 px-4 flex items-center justify-between border-b border-border bg-bg-1 shrink-0">
          <div class="flex items-center gap-2">
            <span class="text-lg">🌌</span>
            <h2 class="text-sm font-semibold">Galaxy Map</h2>
            <span class="text-[11px] text-fg-subtle">
              {counts().star + counts().planet + counts().galaxy} / {ALL_CELESTIAL.length} visited
            </span>
          </div>
          <button
            type="button"
            class="ag-btn ag-btn-ghost ag-btn-icon"
            onClick={() => props.onClose()}
            aria-label="Close galaxy map"
            title="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div class="flex-1 relative min-h-0">
          <canvas ref={setCanvasRef} class="absolute inset-0 w-full h-full" />
          {/* Legend */}
          <div class="absolute bottom-3 left-3 rounded-lg border border-border/60 bg-bg-1/90 px-3 py-2 text-[11px] shadow-lg">
            <div class="flex items-center gap-3">
              <For each={KINDS}>
                {(kind) => (
                  <div class="flex items-center gap-1.5">
                    <span
                      class="w-2 h-2 rounded-full"
                      style={{ "background-color": KIND_COLOR[kind] }}
                    />
                    <span class="text-fg-subtle">{KIND_LABEL[kind]}</span>
                    <span class="font-mono text-fg">{counts()[kind]}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
