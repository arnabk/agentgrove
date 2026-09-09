# Memory debugging (`mem.log`)

The renderer once grew to a multi-GB RSS over a long session with no
JS-side trace. To tell a *real* fix from a *misreported* number, the app
now writes a continuous, low-cost memory trend you can read after the
fact.

## Where

`<state_dir>/logs/mem.log` — one JSON object per line, size-rotated at
5 MB to `mem.log.1` so instrumentation can't itself leak disk. Default
state dir is `<repo>/.data`.

## What each line holds

Emitted by the FE monitor (`apps/web/src/lib/memMonitor.ts`) and enriched
server-side (`crates/agentgrove-api/src/diag.rs::mem_sample`):

| field            | meaning |
| ---------------- | ------- |
| `ts`             | ISO 8601 sample time |
| `reason`         | `load` (first), `heartbeat` (every ~5 min), `growth` (sustained climb), `unload` (tab closing) |
| `be_rss_bytes`   | backend process RSS at sample time (added by the BE) |
| `heap_mb`        | JS heap used (`performance.memory`) |
| `heap_limit_mb`  | JS heap ceiling |
| `tab_bytes`      | whole-tab bytes (`measureUserAgentSpecificMemory`), when cross-origin isolated |
| `dom`            | live DOM node count (detached-node leaks show here, not in heap) |
| `ws`             | live WebSocket count (FE-instrumented constructor) |
| `listeners`      | live `addEventListener` count (FE-instrumented `EventTarget`) |
| `ag_total_bytes` | AgentGrove self-attributed bytes (the memory accountant) |
| `breakdown`      | top subsystems `[ {id, bytes} ]` — *which* part grew |
| `tab_uptime_s`   | seconds since the monitor started (trend x-axis) |
| `visible`        | tab visibility (hidden tabs GC differently) |

## Reading it

Is the leak fixed, or is the number wrong? Plot the series over a long
session:

```sh
# heap / dom / listeners / be-rss over time
python3 - <<'PY'
import json
for l in open(".data/logs/mem.log"):
    d = json.loads(l)
    print(d["tab_uptime_s"], d.get("heap_mb"), d["dom"], d["listeners"],
          round((d.get("be_rss_bytes") or 0)/1048576, 1))
PY
```

Interpretation:

- **Flat `heap_mb` + flat `dom` + flat `listeners` + flat `be_rss`** over
  hours → the fix holds; a rising Task-Manager number was a
  misattribution, not a JS leak.
- **`dom` or `listeners` climbing while `heap_mb` stays flat** → a
  detached-node / listener leak (retained by a stale closure); check the
  subsystem in `breakdown`.
- **`heap_mb` climbing toward `heap_limit_mb`** → a real object/closure
  leak; `breakdown` names the subsystem.
- **`be_rss_bytes` climbing while FE stays flat** → a backend-side leak
  (PTY, sqlx pool, event history), not the renderer.

A `reason:"growth"` line is written immediately when heap or DOM climb
monotonically across the sample ring, so the moment of runaway is
captured rather than only the 5-minute heartbeat.

## Cost

One 15 s timer (shared with spike detection), an async whole-tab
measurement that never blocks the tick, a fire-and-forget `keepalive`
POST, and a size-rotated append on the BE. Negligible against the
platform's normal work.
