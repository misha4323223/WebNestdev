export type Role = "user" | "assistant" | "system" | "tool";
export type AgentEvent = { type: "run.started"; runId: string } | { type: "message.delta"; runId: string; delta: string } | { type: "tool.started"; runId: string; toolCallId: string; name: string; input: unknown } | { type: "tool.finished"; runId: string; toolCallId: string; name: string; output: unknown } | { type: "run.completed"; runId: string } | { type: "run.failed"; runId: string; error: string };
export type ChatMessage = { role: Role; content: string };
export type AgentRunRequest = { projectId: string; messages: ChatMessage[]; model?: string };
export type ToolContext = { projectId: string; runId: string };
export type ToolDefinition = { name: string; description: string; execute: (input: unknown, context: ToolContext) => Promise<unknown> };