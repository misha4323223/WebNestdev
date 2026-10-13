import { registerTool } from "../tool-registry.js";
import type { PlanItem, PlanItemStatus, PlanState } from "../types.js";

const MAX_ITEMS = 24;
const MAX_TITLE_CHARS = 200;

const PLAN_UPDATE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      maxItems: MAX_ITEMS,
      description: "The complete ordered plan list. Send the full list every time, not a diff.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "Short user-visible step title" },
          status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Step status" },
          note: { type: "string", description: "Optional short note" },
        },
      },
    },
  },
  required: ["items"],
};

function extractPlanEntries(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  const value = (input ?? {}) as Record<string, unknown>;
  for (const key of ["items", "tasks", "steps", "todo"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  const nested = value.plan;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    for (const key of ["items", "tasks", "steps", "todo"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function normalizeStatus(value: unknown): PlanItemStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "in_progress" || normalized === "inprogress" || normalized === "in-progress" || normalized === "active" || normalized === "started" || normalized === "doing" || normalized === "progress") return "in_progress";
  if (normalized === "done" || normalized === "complete" || normalized === "completed" || normalized === "finished" || normalized === "success" || normalized === "ok") return "done";
  if (normalized === "pending" || normalized === "todo" || normalized === "not_started" || normalized === "new" || normalized === "queued" || normalized === "blocked") return "pending";
  return undefined;
}

/**
 * Normalizes the plan the model sent. Titles are required, the list is bounded, and
 * at most one step stays in progress so the interface never shows two current tasks.
 * It also tolerates common model mistakes: top-level arrays, tasks/steps wrappers,
 * string entries and aliased status values.
 */
export function normalizePlan(input: unknown): PlanState {
  const entries = extractPlanEntries(input);
  if (entries.length === 0) {
    throw new Error('plan.update accepts {"items":[{"title":"Шаг","status":"pending|in_progress|done","note":"необязательно"}]}. Send the complete ordered plan list; if the model sent an empty plan, publish the steps now.');
  }

  let inProgressSeen = false;
  const items: PlanItem[] = [];
  for (const raw of entries.slice(0, MAX_ITEMS)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const rawTitle = typeof raw === "string" ? raw : entry.title ?? entry.name ?? entry.text ?? entry.task;
    const title = typeof rawTitle === "string" ? rawTitle.trim().slice(0, MAX_TITLE_CHARS) : "";
    if (!title) continue;

    const requested = normalizeStatus(entry.status) ?? "pending";
    const status = requested === "in_progress" && inProgressSeen ? "pending" : requested;
    if (status === "in_progress") inProgressSeen = true;

    const rawNote = entry.note ?? entry.description;
    const note = typeof rawNote === "string" ? rawNote.trim().slice(0, MAX_TITLE_CHARS) : "";
    items.push({ title, status, ...(note ? { note } : {}) });
  }

  if (items.length === 0) throw new Error('Each plan step needs a title. Use {"items":[{"title":"Короткий шаг","status":"pending"}]}');
  return { items, updatedAt: new Date().toISOString() };
}

registerTool({
  name: "plan.update",
  description:
    "Publish or update the task plan shown to the user next to the chat. Send the complete ordered list every time, " +
    "not a diff. Input: {items:[{title:string,status:'pending'|'in_progress'|'done',note?:string}]}. " +
    "Use it for any task that needs more than one or two actions: publish the steps before the first change, " +
    "keep exactly one step 'in_progress' while you work on it, mark it 'done' as soon as it is finished and verified, " +
    "and finish with every step 'done'. Titles are shown to the user, so write them in the user's language, short and concrete.",
  parameters: PLAN_UPDATE_PARAMETERS,
  execute: async (input) => {
    const plan = normalizePlan(input);
    const done = plan.items.filter((item) => item.status === "done").length;
    const current = plan.items.find((item) => item.status === "in_progress");
    return {
      ok: true,
      plan,
      progress: { done, total: plan.items.length, current: current?.title ?? null },
      reminder: current
        ? "Plan saved. Work on the step marked in_progress and send the full list again when you start or finish a step."
        : done === plan.items.length
          ? "Plan saved with every step done. Only finish the task if the work is actually complete and verified."
          : "Plan saved. Mark exactly one step in_progress before working on it.",
    };
  },
});
