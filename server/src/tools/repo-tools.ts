import { getSandbox } from "../sandbox-manager.js";
import { registerTool } from "../tool-registry.js";
import { getRepoIndex } from "../agent/repo-index/build.js";
import { findRelevantFiles, repoMapSummary } from "../agent/repo-index/query.js";

/**
 * Read-only orientation tools for large projects. They are registered always, but the run catalog
 * exposes them only when AGENT_REPO_MAP is on; `executeTool` refuses a tool outside the catalog.
 */
registerTool({
  name: "repo.map",
  description:
    "Orient in a large project without reading hundreds of files. Returns a compact map: languages, workspace packages, entry points, test count, top directories and anchor files. " +
    "Use it before a broad search when you do not yet know the project's shape. The map contains no file contents; read exact code with fs.read or fs.outline.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      refresh: { type: "boolean", description: "Rebuild the map immediately instead of using the short-lived cache" },
    },
  },
  execute: async (input, context) => {
    const value = (input ?? {}) as { refresh?: unknown };
    const sandbox = await getSandbox(context.projectId, context.userId);
    const index = await getRepoIndex(sandbox.root, { refresh: value.refresh === true, useDiskCache: false });
    return repoMapSummary(index);
  },
});

registerTool({
  name: "repo.find",
  description:
    "Find files relevant to a task using the repository graph, not just filename text. Input: {query:string,limit?:number,includeTests?:boolean,refresh?:boolean}. " +
    "Returns paths with score, reason, exported symbols, imports and direct dependents. Use it to locate a feature across modules, then read exact files with fs.read.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "What to find: a feature, symbol, route, component or error" },
      limit: { type: "number", description: "How many files to return, 1–20; default 10" },
      includeTests: { type: "boolean", description: "Include test files; default true" },
      refresh: { type: "boolean", description: "Rebuild the index immediately instead of using the short-lived cache" },
    },
  },
  execute: async (input, context) => {
    const value = (input ?? {}) as { query?: unknown; limit?: unknown; includeTests?: unknown; refresh?: unknown };
    const query = typeof value.query === "string" ? value.query.trim() : "";
    if (!query) throw new Error("repo.find: нужен query — что искать");
    const limit = Math.max(1, Math.min(20, Math.floor(Number(value.limit) || 10)));
    const sandbox = await getSandbox(context.projectId, context.userId);
    const index = await getRepoIndex(sandbox.root, { refresh: value.refresh === true, useDiskCache: false });
    const files = findRelevantFiles(index, query, {
      limit,
      includeTests: value.includeTests !== false,
    });
    return {
      query,
      total: files.length,
      files,
      ...(files.length ? {} : { hint: "Совпадений нет. Попробуйте другое имя символа, route или функции; карта — repo.map." }),
    };
  },
});
