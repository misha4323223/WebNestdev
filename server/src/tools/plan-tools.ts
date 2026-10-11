import { registerTool } from "../tool-registry.js";
import type { PlanItem, PlanItemStatus, PlanState } from "../types.js";

const MAX_ITEMS = 24;
const MAX_TITLE_CHARS = 200;
const STATUSES = new Set<PlanItemStatus>(["pending", "in_progress", "done"]);

/**
 * Normalizes the plan the model sent. Titles are required, the list is bounded, and
 * at most one step stays in progress so the interface never shows two current tasks.
 */
export function normalizePlan(input: unknown): PlanState {
  const value = (input ?? {}) as { items?: unknown };
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new Error("Нужен непустой список items с шагами плана");
  }

  let inProgressSeen = false;
  const items: PlanItem[] = [];
  for (const raw of value.items.slice(0, MAX_ITEMS)) {
    const entry = (raw ?? {}) as { title?: unknown; status?: unknown; note?: unknown };
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, MAX_TITLE_CHARS) : "";
    if (!title) continue;

    const requested = typeof entry.status === "string" && STATUSES.has(entry.status as PlanItemStatus)
      ? (entry.status as PlanItemStatus)
      : "pending";
    const status = requested === "in_progress" && inProgressSeen ? "pending" : requested;
    if (status === "in_progress") inProgressSeen = true;

    const note = typeof entry.note === "string" ? entry.note.trim().slice(0, MAX_TITLE_CHARS) : "";
    items.push({ title, status, ...(note ? { note } : {}) });
  }

  if (items.length === 0) throw new Error("Ни один шаг плана не содержит заголовка");
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
