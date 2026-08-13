import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ALL_CELESTIAL, type CelestialKind } from "../lib/celestial";

/* global CanvasRenderingContext2D, WheelEvent */

interface Props {
  visited: () => Set<string>;
  onClose: () => void;
}

const KIND_COLOR: Record<CelestialKind, string> = {
  star: "#fbbf24",
  planet: "#60a5fa",
  galaxy: "#c084fc",
};

const KIND_SIZE: Record<CelestialKind, number> = {
  star: 4.5,
  planet: 3.5,
  galaxy: 9,
};

const KIND_LABEL: Record<CelestialKind, string> = {
  star: "Stars",
  planet: "Planets",
  galaxy: "Galaxies",
};

const KINDS: CelestialKind[] = ["star", "planet", "galaxy"];

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5.0;
const ZOOM_STEP = 1.2;

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
  const maxRadius = Math.min(width, height) * 0.4;
  // Even radial distribution so bodies fill the galaxy disk
  const r = Math.sqrt(h / 0xffffffff) * maxRadius;
  const angle = (h / 0xffffffff) * Math.PI * 2 + r * 0.025;
  return {
    x: width / 2 + r * Math.cos(angle),
    y: height / 2 + r * Math.sin(angle),
  };
}

export default function GalaxyMapDialog(props: Props) {
  const visited = createMemo(() => props.visited());

  const counts = createMemo(() => {
    const v = visited();
    const out = { star: 0, planet: 0, galaxy: 0 };
    for (const body of ALL_CELESTIAL) {
      if (v.has(body.display)) out[body.kind]++;
    }
    return out;
  });

  const visitedList = createMemo(() => {
    const v = visited();
    return ALL_CELESTIAL.filter((b) => v.has(b.display)).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.display.localeCompare(b.display);
    });
  });

  const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement>();

  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });

  function zoomToPoint(screenX: number, screenY: number, newZoom: number) {
    const canvas = canvasRef();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const z = zoom();
    const p = pan();
    // World point currently under the mouse.
    const worldX = centerX + (screenX - centerX - p.x) / z;
    const worldY = centerY + (screenY - centerY - p.y) / z;
    // Adjust pan so that world point stays under the mouse after zoom.
    const newPanX = screenX - centerX - newZoom * (worldX - centerX);
    const newPanY = screenY - centerY - newZoom * (worldY - centerY);
    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  }

  function handleWheel(ev: WheelEvent) {
    ev.preventDefault();
    const canvas = canvasRef();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const z = zoom();
    const factor = Math.exp(-ev.deltaY / 500);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
    zoomToPoint(mx, my, newZoom);
  }

  let isDragging = false;
  let dragStart = { x: 0, y: 0 };
  let panStart = { x: 0, y: 0 };

  function handleMouseDown(ev: MouseEvent) {
    const canvas = canvasRef();
    if (!canvas) return;
    isDragging = true;
    dragStart = { x: ev.clientX, y: ev.clientY };
    panStart = { ...pan() };
    canvas.style.cursor = "grabbing";
  }

  function handleMouseMove(ev: MouseEvent) {
    if (!isDragging) return;
    const dx = ev.clientX - dragStart.x;
    const dy = ev.clientY - dragStart.y;
    setPan({ x: panStart.x + dx, y: panStart.y + dy });
  }

  function handleMouseUp() {
    const canvas = canvasRef();
    if (canvas) canvas.style.cursor = "grab";
    isDragging = false;
  }

  function zoomIn() {
    setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP));
  }
  function zoomOut() {
    setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP));
  }
  function resetZoom() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  const draw = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width * dpr, height * dpr);
    ctx.scale(dpr, dpr);

    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(width, height) * 0.42;

    // Procedural background stars (screen coordinates, stay fixed)
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

    const z = zoom();
    const p = pan();

    // World transform: map world coordinates centered at (centerX, centerY)
    // to screen coordinates with zoom + pan.
    ctx.save();
    ctx.translate(centerX + p.x, centerY + p.y);
    ctx.scale(z, z);
    ctx.translate(-centerX, -centerY);

    // Galaxy boundaries: concentric rings + radial spokes
    const rings = [
      { r: maxRadius * 0.25, label: "Core" },
      { r: maxRadius * 0.5, label: "Inner Rim" },
      { r: maxRadius * 0.75, label: "Outer Rim" },
      { r: maxRadius, label: "Outer Reaches" },
    ];

    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1 / z;
    for (const ring of rings) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, ring.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + Math.cos(angle) * maxRadius, centerY + Math.sin(angle) * maxRadius);
      ctx.stroke();
    }

    // Ring labels
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.font =
      '10px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = "left";
    for (const ring of rings) {
      if (ring.label) {
        ctx.fillText(ring.label, centerX + ring.r + 4, centerY - 2);
      }
    }

    const v = visited();

    // Visited constellation lines
    const visitedPositions: { x: number; y: number }[] = [];
    for (const body of ALL_CELESTIAL) {
      if (v.has(body.display)) {
        visitedPositions.push(bodyPosition(body.display, width, height));
      }
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1 / z;
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
      const size = isVisited ? KIND_SIZE[body.kind] : 1.2;

      if (isVisited) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, size * 3.5, 0, Math.PI * 2);
        ctx.fillStyle = `${color}18`;
        ctx.fill();
      }

      if (body.kind === "galaxy") {
        // Galaxies look like tilted ellipses with a bright core
        const angle = hashString(body.display) % 360;
        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate((angle * Math.PI) / 180);
        ctx.beginPath();
        ctx.ellipse(0, 0, size * 1.6, size * 0.6, 0, 0, Math.PI * 2);
        ctx.fillStyle = isVisited ? `${color}30` : `${color}15`;
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(0, 0, size * 1.6, size * 0.6, 0, 0, Math.PI * 2);
        ctx.strokeStyle = isVisited ? color : `${color}50`;
        ctx.lineWidth = 1 / z;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = isVisited ? "#ffffff" : `${color}60`;
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
        ctx.fillStyle = isVisited ? color : `${color}35`;
        ctx.fill();
      }

      // Labels: always show galaxy names; show visited star/planet names
      if (body.kind === "galaxy" || isVisited) {
        const labelColor = isVisited ? "rgba(255, 255, 255, 0.9)" : "rgba(255, 255, 255, 0.4)";
        ctx.fillStyle = labelColor;
        ctx.font =
          '10px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = "left";
        ctx.fillText(body.display, pos.x + size + 5, pos.y + 3);
      }
    }

    ctx.restore();
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
  });
  // Solid's onMount IGNORES its return value (unlike React's useEffect),
  // so the resize listener above would otherwise never be removed —
  // leaking one listener plus this dialog's captured scope on every open.
  // Register the teardown as a real onCleanup instead.
  onCleanup(() => window.removeEventListener("resize", resizeAndDraw));

  createEffect(() => {
    visited();
    zoom();
    pan();
    resizeAndDraw();
  });

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="w-full max-w-6xl h-[85vh] rounded-xl border border-border bg-bg-1 shadow-2xl flex flex-col overflow-hidden">
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
        <div class="flex-1 flex min-h-0 overflow-hidden">
          <div class="flex-1 relative min-h-0">
            <canvas
              ref={setCanvasRef}
              class="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            />
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

            {/* Zoom controls */}
            <div class="absolute bottom-3 right-3 rounded-lg border border-border/60 bg-bg-1/90 px-2 py-2 text-[11px] shadow-lg flex items-center gap-2">
              <button
                type="button"
                class="ag-btn ag-btn-ghost ag-btn-icon"
                onClick={zoomOut}
                aria-label="Zoom out"
                title="Zoom out"
              >
                −
              </button>
              <span class="font-mono text-fg w-12 text-center">{Math.round(zoom() * 100)}%</span>
              <button
                type="button"
                class="ag-btn ag-btn-ghost ag-btn-icon"
                onClick={zoomIn}
                aria-label="Zoom in"
                title="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                class="ag-btn ag-btn-ghost"
                onClick={resetZoom}
                aria-label="Reset zoom"
                title="Reset zoom"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Visited list panel */}
          <div class="w-56 border-l border-border bg-bg-1/50 flex flex-col shrink-0">
            <div class="px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              Visited
            </div>
            <div class="flex-1 overflow-y-auto p-2 space-y-3">
              <Show
                when={visitedList().length > 0}
                fallback={
                  <p class="text-[11px] text-fg-subtle italic px-1">
                    No celestial visits yet. Create worktrees with branch names like{" "}
                    <code class="font-mono">feature/&lt;star|planet|galaxy&gt;</code> to populate
                    the map.
                  </p>
                }
              >
                <For each={KINDS}>
                  {(kind) => {
                    const items = () =>
                      visitedList()
                        .filter((b) => b.kind === kind)
                        .sort((a, b) => a.display.localeCompare(b.display));
                    return (
                      <Show when={items().length > 0}>
                        <div class="rounded-md border border-border/60 bg-bg-2/40 p-2">
                          <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-1.5">
                            <span
                              class="w-1.5 h-1.5 rounded-full"
                              style={{ "background-color": KIND_COLOR[kind] }}
                            />
                            {KIND_LABEL[kind]}
                          </div>
                          <div class="flex flex-wrap gap-1">
                            <For each={items()}>
                              {(body) => (
                                <span
                                  class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono border"
                                  style={{
                                    "border-color": `${KIND_COLOR[body.kind]}40`,
                                    "background-color": `${KIND_COLOR[body.kind]}15`,
                                    color: KIND_COLOR[body.kind],
                                  }}
                                >
                                  {body.display}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    );
                  }}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
