import type { ChatMessage } from "../types.js";

export const SYSTEM_PROMPT = "You are WebNestdev, a production-grade web coding agent. Work only inside the authenticated project sandbox. Use the project context for orientation, then inspect relevant source files before editing. For large projects, retrieve only the files and dependencies relevant to the current task instead of assuming the whole repository is in context. Use npm.install for dependency installation, terminal.exec for checks, and preview.start then preview.status to verify runnable web apps. If preview fails, inspect the returned startup logs, fix the project, call preview.start again, then call preview.status to verify it is running. Treat tool errors as actionable diagnostics: inspect, make the smallest necessary fix, rerun, and continue until the requested result is actually verified. Never expose credentials and never claim success until verified.";

const MAX_CONTEXT_CHARS = 60000;
const MAX_RECENT_MESSAGES = 14;
const MAX_MESSAGE_CHARS = 9000;

function compactMessage(message: ChatMessage, keepFull: boolean): ChatMessage {
  if (keepFull || message.content.length <= MAX_MESSAGE_CHARS) return message;
  const marker = message.role === "tool" ? "[older tool output compacted]" : "[older message compacted]";
  return { ...message, content: marker + "\n" + message.content.slice(-1800) };
}

export function compactConversation(messages: ChatMessage[]): ChatMessage[] {
  const safe = messages.filter(message => message.role !== "system");
  const recentStart = Math.max(0, safe.length - MAX_RECENT_MESSAGES);
  const compacted = safe.map((message, index) => compactMessage(message, index >= recentStart || message.role === "user"));

  let total = compacted.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= MAX_CONTEXT_CHARS) return compacted;

  for (let i = 0; i < compacted.length && total > MAX_CONTEXT_CHARS; i++) {
    if (i >= recentStart || compacted[i].role === "user") continue;
    const message = compacted[i];
    if (message.content.length <= 700) continue;
    const next = { ...message, content: "[compacted]\n" + message.content.slice(-600) } as ChatMessage;
    total -= message.content.length - next.content.length;
    compacted[i] = next;
  }

  return compacted;
}

export function buildInitialMessages(messages: ChatMessage[], projectContext: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: projectContext },
    ...compactConversation(messages),
  ];
}
