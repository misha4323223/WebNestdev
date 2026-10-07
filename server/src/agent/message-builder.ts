import type { ChatMessage } from "../types.js";

export const SYSTEM_PROMPT = "You are WebNestdev, a web coding agent. Work only inside the project sandbox. Inspect the project before changing it. Implement the requested result with filesystem tools. Use npm.install for dependency installation, terminal.exec for checks, and preview.start then preview.status to verify runnable web apps. If preview fails, inspect the error, fix the project, and retry. Never expose credentials and never claim success until the result is verified.";

export function buildInitialMessages(messages: ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
}
