import { api, type Prompt, type AgentEvent } from "../api/client";

/**
 * Fetch every prompt for a chat (the windowed `getChat` only returns
 * the last N) by repeatedly backfilling older pages until `at_start`.
 * Returns prompts oldest-first.
 */
async function fetchAllPrompts(chatId: string): Promise<Prompt[]> {
  const view = await api.getChat(chatId);
  let prompts = [...view.prompts];
  let atStart = prompts.length >= view.prompts_total;
  while (!atStart && prompts.length > 0) {
    const oldest = prompts[0];
    if (!oldest) break;
    const page = await api.listPrompts(chatId, oldest.seq, 200);
    if (page.prompts.length === 0) break;
    prompts = [...page.prompts, ...prompts];
    atStart = page.at_start;
  }
  return prompts;
}

/** Concatenate streamed token text from a prompt's events into the
 *  assistant's final reply. Tool calls/results are summarized inline. */
function renderEvents(events: AgentEvent[]): string {
  const out: string[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.trim()) out.push(buffer.trim());
    buffer = "";
  };
  for (const ev of events) {
    switch (ev.type) {
      case "token":
        buffer += ev.text;
        break;
      case "thinking":
        // Thinking blocks are internal; skip from the transcript.
        break;
      case "tool_call":
        flush();
        out.push(`> **Tool call:** \`${ev.name}\``);
        break;
      case "tool_result":
        flush();
        out.push(`> **Tool result:** \`${ev.name}\``);
        break;
      case "error":
        flush();
        out.push(`> ⚠️ **Error:** ${ev.message}`);
        break;
      default:
        break;
    }
  }
  flush();
  return out.join("\n\n");
}

/** Build a Markdown transcript of the whole chat. */
function toMarkdown(title: string, prompts: Prompt[]): string {
  const lines: string[] = [`# ${title || "Chat"}`, ""];
  for (const p of prompts) {
    lines.push(`## You`, "", p.content.trim(), "");
    const reply = renderEvents(p.events);
    if (reply) {
      lines.push(`## Assistant`, "", reply, "");
    }
  }
  return lines.join("\n");
}

function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "chat"
  );
}

/** Fetch the full chat, render it as Markdown, and download it. */
export async function exportChat(chatId: string, title: string): Promise<void> {
  const prompts = await fetchAllPrompts(chatId);
  const md = toMarkdown(title, prompts);
  triggerDownload(`${slugify(title)}.md`, md);
}
