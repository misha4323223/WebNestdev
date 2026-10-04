import type { ToolDefinition } from "./types.js";
const tools = new Map<string, ToolDefinition>();
export function registerTool(tool: ToolDefinition) { if (tools.has(tool.name)) throw new Error("Tool already registered: " + tool.name); tools.set(tool.name, tool); }
export function getTool(name: string) { return tools.get(name); }
export function listTools() { return [...tools.values()].map(({ name, description }) => ({ name, description })); }
export function getToolDefinitions() { return [...tools.values()].map(({ name, description }) => ({ type: "function", function: { name, description, parameters: { type: "object", additionalProperties: true } } })); }