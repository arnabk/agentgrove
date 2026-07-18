import { For, Show, type JSX } from "solid-js";
import type { AgentEvent } from "../../api/client";

/**
 * Tool-activity rail rendering for the chat timeline.
 *
 * Pulls a chat-prompt's stream of `tool_call` / `tool_result` /
 * `error` / `truncated` events into a tidy full-width vertical
 * rail of rows: icon · label · monospace command preview. Calls
 * paired with their matching result get dimmed (the work
 * completed); orphan calls stay full-opacity (still in flight).
 *
 * Extracted from `ChatPane.tsx` to keep that file under the
 * "manageable monster" threshold; the registry + helpers are
 * pure presentation with no chat-state coupling so they live
 * cleanly on their own.
 */

// ---------- icon registry ----------------------------------------------

/** Tool registry: maps the CLI's tool name (Anthropic / opencode
 *  conventions) to a display label + an inline SVG glyph rendered
 *  full-width in the tool-activity rail. Falls back to a generic
 *  bullet for unknown names so new tools degrade gracefully. */
const TOOL_META: Record<string, { label: string; icon: () => JSX.Element }> = {
  Bash: { label: "Bash", icon: () => <ToolIcon glyph="terminal" /> },
  Read: { label: "Read", icon: () => <ToolIcon glyph="file" /> },
  Write: { label: "Write", icon: () => <ToolIcon glyph="file-pen" /> },
  Edit: { label: "Edit", icon: () => <ToolIcon glyph="file-pen" /> },
  Glob: { label: "Glob", icon: () => <ToolIcon glyph="file" /> },
  Grep: { label: "Grep", icon: () => <ToolIcon glyph="search" /> },
  Search: { label: "Search", icon: () => <ToolIcon glyph="search" /> },
  WebFetch: { label: "Fetch", icon: () => <ToolIcon glyph="globe" /> },
  WebSearch: { label: "Web", icon: () => <ToolIcon glyph="globe" /> },
  Task: { label: "Task", icon: () => <ToolIcon glyph="sparkles" /> },
  TodoWrite: { label: "Todo", icon: () => <ToolIcon glyph="checks" /> },
};

function metaFor(name: string): { label: string; icon: () => JSX.Element } {
  return (
    TOOL_META[name] ?? {
      label: name || "tool",
      icon: () => <ToolIcon glyph="dot" />,
    }
  );
}

/** Inline Lucide-style glyphs, em-sized so they track the chat font. */
function ToolIcon(props: { glyph: string }) {
  const common = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
    width: "1em",
    height: "1em",
    "aria-hidden": true as const,
  };
  switch (props.glyph) {
    case "terminal":
      return (
        <svg {...common}>
          <path d="m4 9 4 3-4 3" />
          <path d="M12 15h8" />
          <rect x="2" y="4" width="20" height="16" rx="2" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case "file-pen":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h7" />
          <path d="M14 2v6h6" />
          <path d="m17 17 4 4" />
          <path d="m21 13-4 4-2 .5.5-2 4-4a1.4 1.4 0 0 1 1.5 1.5z" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "globe":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a14 14 0 0 1 0 20" />
          <path d="M12 2a14 14 0 0 0 0 20" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...common}>
          <path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
          <path d="M19 17v4" />
          <path d="M17 19h4" />
        </svg>
      );
    case "checks":
      return (
        <svg {...common}>
          <path d="M3 12 7 16 17 6" />
          <path d="m11 16 4-4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}

// ---------- args -> preview --------------------------------------------

/** Pull a single-line command / preview string out of a tool_call's
 *  free-form `args` payload. The shape is provider-specific:
 *    - Bash → { command: "git log …" }
 *    - Read → { file_path / path }
 *    - Glob/Grep → { pattern, path? }
 *    - WebFetch → { url }
 *  Anything else gets a JSON-stringified one-liner. */
function previewForArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pickStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  switch (name) {
    case "Bash":
      return pickStr("command", "cmd") ?? "";
    case "Read":
    case "Write":
    case "Edit":
      return pickStr("file_path", "path", "filename") ?? "";
    case "Glob":
    case "Grep":
    case "Search": {
      const pat = pickStr("pattern", "query", "q");
      const path = pickStr("path");
      if (pat && path) return `${pat}  ${path}`;
      return pat ?? path ?? "";
    }
    case "WebFetch":
    case "WebSearch":
      return pickStr("url", "query") ?? "";
    case "TodoWrite":
      return Array.isArray(a.todos) ? `${a.todos.length} item(s)` : "";
    case "Task":
      return pickStr("description", "prompt") ?? "";
    default: {
      // Generic: prefer "description" if the CLI supplied one,
      // else the first string-valued field, else stringified args.
      const desc = pickStr("description");
      if (desc) return desc;
      for (const v of Object.values(a)) {
        if (typeof v === "string" && v.trim()) return v;
      }
      return safeStringify(args);
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return String(v);
  }
}

// ---------- row component + pairing logic ------------------------------

/** Single row in the tool-activity rail: icon · label · mono
 *  command preview. Full bubble width so long commands have room.
 *  Used for both calls (full opacity) and results (dimmed). */
export function ToolRow(props: {
  ev: Extract<AgentEvent, { type: "tool_call" | "tool_result" }>;
  dim?: boolean;
}) {
  const meta = metaFor(props.ev.name || "");
  const args =
    props.ev.type === "tool_call" ? props.ev.args : (props.ev as { result: unknown }).result;
  const preview = previewForArgs(props.ev.name, args);
  const title =
    props.ev.type === "tool_call"
      ? safeStringify(props.ev.args)
      : safeStringify((props.ev as { result: unknown }).result);
  return (
    <div
      class="flex items-center gap-2 min-w-0 text-[12.5px] leading-snug"
      classList={{ "opacity-60": Boolean(props.dim) }}
      title={title}
      data-testid={props.ev.type === "tool_call" ? "tool-call" : "tool-result"}
    >
      <span class="text-fg-subtle shrink-0">{meta.icon()}</span>
      <span class="font-medium text-fg shrink-0">{meta.label}</span>
      <Show when={preview}>
        <span class="font-mono text-[11.5px] text-fg-subtle bg-bg-2/60 rounded px-1.5 py-0.5 truncate min-w-0">
          {preview}
        </span>
      </Show>
    </div>
  );
}

/** Pair `tool_call` events with their `tool_result` (by `id`) so the
 *  rail renders one row per logical tool invocation. Calls without a
 *  result yet (in-flight) stay un-paired and show un-dimmed. Result
 *  events without a preceding call are surfaced on their own as a
 *  defensive fallback. */
export interface ToolEntry {
  call?: Extract<AgentEvent, { type: "tool_call" }>;
  result?: Extract<AgentEvent, { type: "tool_result" }>;
  /** Stable key for solid's For: id when known, else index. */
  key: string;
}

export function pairTools(evs: AgentEvent[]): {
  entries: ToolEntry[];
  errors: Extract<AgentEvent, { type: "error" }>[];
  truncated: Extract<AgentEvent, { type: "truncated" }>[];
} {
  const entries: ToolEntry[] = [];
  const byId = new Map<string, number>();
  const errors: Extract<AgentEvent, { type: "error" }>[] = [];
  const truncated: Extract<AgentEvent, { type: "truncated" }>[] = [];
  evs.forEach((ev, i) => {
    if (ev.type === "tool_call") {
      const id = ev.id ?? `idx-${i}`;
      const entry: ToolEntry = { call: ev, key: id };
      byId.set(id, entries.length);
      entries.push(entry);
    } else if (ev.type === "tool_result") {
      const id = ev.id ?? "";
      const idx = id ? byId.get(id) : undefined;
      if (idx !== undefined) {
        entries[idx]!.result = ev;
      } else {
        entries.push({ result: ev, key: `result-${i}` });
      }
    } else if (ev.type === "error") {
      errors.push(ev);
    } else if (ev.type === "truncated") {
      truncated.push(ev);
    }
  });
  return { entries, errors, truncated };
}

// ---------- composed rail ----------------------------------------------

/** Full tool-activity rail for a single prompt. Lays out paired
 *  call+result rows, then any orphan errors / truncated chips. */
export function ToolRail(props: { events: AgentEvent[]; promptId: string }) {
  const paired = pairTools(props.events);
  return (
    <div class="flex flex-col gap-1.5 px-1" data-testid={`tool-rail-${props.promptId}`}>
      <For each={paired.entries}>
        {(entry) => (
          <Show when={entry.call ?? entry.result} fallback={null}>
            <ToolRow
              ev={
                (entry.call ?? entry.result) as Extract<
                  AgentEvent,
                  { type: "tool_call" | "tool_result" }
                >
              }
              dim={Boolean(entry.call && entry.result)}
            />
          </Show>
        )}
      </For>
      <For each={paired.errors}>
        {(ev) => (
          <div class="text-[12px] text-danger flex items-start gap-2" data-testid="tool-error">
            <span aria-hidden="true">⚠</span>
            <span class="font-mono text-[11.5px] whitespace-pre-wrap">{ev.message}</span>
          </div>
        )}
      </For>
      <For each={paired.truncated}>
        {(ev) => (
          <div class="text-[11.5px] text-fg-subtle italic" data-testid="tool-truncated">
            ⋯ {ev.dropped} earlier event{ev.dropped === 1 ? "" : "s"} dropped
          </div>
        )}
      </For>
    </div>
  );
}
