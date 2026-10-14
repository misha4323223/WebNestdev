import type { ToolDefinition } from "./types.js";
const tools = new Map<string, ToolDefinition>();
export function registerTool(tool: ToolDefinition) { if (tools.has(tool.name)) throw new Error("Tool already registered: " + tool.name); tools.set(tool.name, tool); }
export function getTool(name: string) { return tools.get(name); }
export function listTools() { return [...tools.values()].map(({ name, description }) => ({ name, description })); }
/**
 * The tool list sent to the model. Each tool's own `parameters` travels with it: a model that cannot
 * see the exact input shape guesses, and a guessed call costs a whole step. Tools that define no
 * schema stay open objects (`additionalProperties: true`), as before.
 */
export function getToolDefinitions() { return [...tools.values()].map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters: parameters ?? { type: "object", additionalProperties: true } } })); }
/** Names only — the error a model reads after calling something that does not exist. */
export function toolNames() { return [...tools.keys()].sort(); }