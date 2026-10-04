import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentRunRequest } from "./types.js";
import { createProvider } from "./provider.js";

export type EventSink = (event: AgentEvent) => void;

const provider = createProvider();
const systemPrompt = "You are WebNestdev, a web coding agent. Work only inside the user's project sandbox. Never expose provider credentials.";

export class AgentRuntime {
  async run(request: AgentRunRequest, emit: EventSink) {
    const runId = randomUUID();
    emit({ type: "run.started", runId });
    try {
      const last = request.messages.at(-1)?.content?.trim() ?? "";
      if (!last) throw new Error("Empty prompt");
      const messages = [{ role: "system" as const, content: systemPrompt }, ...request.messages];
      const model = request.model ?? process.env.AI_MODEL ?? "llama3.2";
      let produced = false;
      for await (const chunk of provider.stream(messages, model)) {
        if (chunk.type === "text" && chunk.text) {
          produced = true;
          emit({ type: "message.delta", runId, delta: chunk.text });
        }
      }
      if (!produced) emit({ type: "message.delta", runId, delta: "Модель не вернула текстовый ответ." });
      emit({ type: "run.completed", runId });
    } catch (error) {
      emit({ type: "run.failed", runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}