import type { ChatMessage } from "./types.js";

export type ProviderChunk = { type: "text"; text: string } | { type: "done" };

export interface Provider {
  stream(messages: ChatMessage[], model: string, signal?: AbortSignal): AsyncGenerator<ProviderChunk>;
}

export function createProvider(): Provider {
  const baseUrl = process.env.AI_BASE_URL ?? "http://localhost:11434";
  const apiKey = process.env.AI_API_KEY;
  const provider = process.env.AI_PROVIDER ?? "ollama";
  return provider === "ollama"
    ? new OllamaProvider(baseUrl, apiKey)
    : new OpenAICompatibleProvider(baseUrl, apiKey);
}

class OllamaProvider implements Provider {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  async *stream(messages: ChatMessage[], model: string, signal?: AbortSignal) {
    const response = await fetch(new URL("/api/chat", this.baseUrl), {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: "Bearer " + this.apiKey } : {}) },
      body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: true }),
    });
    if (!response.ok) throw new Error("AI provider returned HTTP " + response.status);
    if (!response.body) throw new Error("AI provider returned no stream");
    for await (const chunk of readLines(response.body)) {
      if (!chunk) continue;
      const data = JSON.parse(chunk) as { message?: { content?: string }; done?: boolean };
      if (data.message?.content) yield { type: "text", text: data.message.content };
      if (data.done) break;
    }
    yield { type: "done" };
  }
}

class OpenAICompatibleProvider implements Provider {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  async *stream(messages: ChatMessage[], model: string, signal?: AbortSignal) {
    const response = await fetch(new URL("/v1/chat/completions", this.baseUrl), {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: "Bearer " + this.apiKey } : {}) },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!response.ok) throw new Error("AI provider returned HTTP " + response.status);
    if (!response.body) throw new Error("AI provider returned no stream");
    for await (const line of readLines(response.body)) {
      if (!line || line === "[DONE]") continue;
      const data = JSON.parse(line) as { choices?: Array<{ delta?: { content?: string } }> };
      const text = data.choices?.[0]?.delta?.content;
      if (text) yield { type: "text", text };
    }
    yield { type: "done" };
  }
}

async function* readLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      }
    }
    const last = buffer.trim();
    if (last) yield last.startsWith("data:") ? last.slice(5).trim() : last;
  } finally {
    reader.releaseLock();
  }
}