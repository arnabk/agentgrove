#!/usr/bin/env node
// Lightweight opencode-compatible shim for the demo container.
// Talks directly to the host's 9router OpenAI-compatible endpoint at
// http://host.docker.internal:20128/v1 so the AgentGrove UI can show
// real streaming AI responses without the full Electron desktop app.

const http = require("http");

const API_KEY = process.env.OPENCODE_API_KEY || "sk_9router";
const BASE_URL = process.env.OPENCODE_BASE_URL || "http://host.docker.internal:20128/v1";

const MODELS = [
  "9router/Development",
  "9router/cc/claude-sonnet-4-6",
  "9router/gemini/gemini-2.0-flash-lite",
  "9router/kimi/kimi-latest",
];

function models() {
  for (const m of MODELS) console.log(m);
}

function normalizeModel(model) {
  // 9router/Development -> Development (the OpenAI-compatible model id)
  if (model.startsWith("9router/")) return model.slice("9router/".length);
  return model;
}

function postChatCompletions(model, prompt, onDelta, onDone) {
  const url = new URL(`${BASE_URL}/chat/completions`);
  const body = JSON.stringify({
    model: normalizeModel(model),
    messages: [{ role: "user", content: prompt }],
    stream: true,
    max_tokens: 2048,
  });

  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) onDelta("content", delta.content);
            if (delta.reasoning_content) onDelta("reasoning", delta.reasoning_content);
          } catch (e) {
            // ignore malformed sse lines
          }
        }
      });
      res.on("end", onDone);
      res.on("error", onDone);
    }
  );
  req.on("error", onDone);
  req.write(body);
  req.end();
}

function run() {
  const args = process.argv.slice(2);
  let model = "9router/Development";
  let prompt = "";
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      model = args[++i] || model;
    } else if (arg === "--dir" || arg === "--session" || arg === "--dangerously-skip-permissions") {
      // consume optional value for --dir/--session; others are flags
      if (arg === "--dir" || arg === "--session") i++;
    } else if (arg === "--format") {
      i++; // json
    } else if (arg === "--") {
      prompt = args.slice(i + 1).join(" ");
      break;
    } else if (arg.startsWith("--")) {
      // unknown flag; ignore
    } else if (!prompt) {
      prompt = args.slice(i).join(" ");
      break;
    }
    i++;
  }

  const sessionId = "demo_session_" + Date.now();
  const messageId = "demo_msg_" + Date.now();
  const partId = "demo_part_" + Date.now();

  console.log(JSON.stringify({
    type: "step_start",
    sessionID: sessionId,
    part: { messageID: messageId },
  }));

  let currentContent = "";
  let currentReasoning = "";

  postChatCompletions(
    model,
    prompt,
    (kind, text) => {
      if (kind === "content") {
        currentContent += text;
        console.log(JSON.stringify({
          type: "text",
          part: { id: partId, text: currentContent },
        }));
      } else if (kind === "reasoning") {
        currentReasoning += text;
        console.log(JSON.stringify({
          type: "reasoning",
          part: { text: currentReasoning },
        }));
      }
    },
    () => {
      process.exit(0);
    }
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "models") {
    models();
    return;
  }
  if (args[0] === "run") {
    run();
    return;
  }
  // Fallback: if first arg looks like a prompt, run it.
  if (args.length > 0 && !args[0].startsWith("-")) {
    process.argv.splice(2, 0, "run");
    run();
    return;
  }
  console.error("Usage: opencode models | opencode run --format json -m <model> -- <prompt>");
  process.exit(1);
}

main();
