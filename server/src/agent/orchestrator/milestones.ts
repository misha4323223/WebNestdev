import type { Milestone, PlanItemStatus, PlanState } from "../../types.js";

/**
 * A milestone is a run-sized unit of work: it names the files, the checks and the exact
 * definition of done. The plan tool validates this shape once, so the runtime can trust it when
 * deciding whether the current run has reached its checkpoint.
 *
 * Pure functions live here; the tool adapter is in `tools/plan-tools.ts`. Keeping the model
 * separate makes it testable without a sandbox, a model or storage.
 */
export const MIN_MILESTONES = 3;
export const MAX_MILESTONES = 7;
const MAX_TITLE = 160;
const MAX_SCOPE = 700;
const MAX_ITEM = 300;
const MAX_CHECK = 500;
const MAX_ESTIMATED_TOKENS = 2_000_000;
const MAX_LIST_ITEMS = 24;

export type MilestoneCheckpoint = {
  /** No in_progress milestone: the run must stop changing the project. */
  closed: boolean;
  allDone: boolean;
  completed: Milestone | null;
  next: Milestone | null;
};

function text(value: unknown, field: string, max: number, required: boolean) {
  if (value === undefined || value === null) {
    if (required) throw new Error("Milestone: поле «" + field + "» обязательно.");
    return "";
  }
  if (typeof value !== "string") throw new Error("Milestone: поле «" + field + "» должно быть строкой.");
  const normalized = value.trim();
  if (required && !normalized) throw new Error("Milestone: поле «" + field + "» не может быть пустым.");
  if (normalized.length > max) throw new Error("Milestone: поле «" + field + "» длиннее " + max + " символов.");
  return normalized;
}

function textList(value: unknown, field: string, max: number) {
  const raw = typeof value === "string" ? [value] : value;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Milestone: поле «" + field + "» должно быть непустым массивом.");
  }
  if (raw.length > MAX_LIST_ITEMS) throw new Error("Milestone: в поле «" + field + "» больше " + MAX_LIST_ITEMS + " пунктов.");
  const result: string[] = [];
  for (const item of raw) {
    const value = text(item, field, max, true);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function status(value: unknown): PlanItemStatus {
  if (value === undefined) return "pending";
  if (value === "pending" || value === "in_progress" || value === "done") return value;
  throw new Error("Milestone: status должен быть pending, in_progress или done.");
}

function entries(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  const value = (input ?? {}) as Record<string, unknown>;
  const raw = value.milestones ?? value.items;
  if (!Array.isArray(raw)) throw new Error("Milestone: передайте {milestones:[...]}.");
  return raw;
}

/**
 * Normalizes a milestone plan and derives the user-visible plan items from it. Exactly one pending
 * milestone becomes `in_progress` when the model did not mark one: a plan without a current step
 * would let the next run start anywhere.
 */
export function normalizeMilestonePlan(input: unknown): PlanState {
  const raw = entries(input);
  if (raw.length < MIN_MILESTONES || raw.length > MAX_MILESTONES) {
    throw new Error("Milestone: нужно от " + MIN_MILESTONES + " до " + MAX_MILESTONES + " этапов, получено " + raw.length + ".");
  }

  const milestones: Milestone[] = [];
  const titles = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Milestone " + (index + 1) + ": ожидался объект.");
    }
    const value = entry as Record<string, unknown>;
    const title = text(value.title, "title", MAX_TITLE, true);
    const key = title.toLocaleLowerCase("ru");
    if (titles.has(key)) throw new Error("Milestone: название «" + title + "» повторяется.");
    titles.add(key);
    const rawEstimate = value.estimatedTokens;
    let estimatedTokens: number | undefined;
    if (rawEstimate !== undefined) {
      if (typeof rawEstimate !== "number" || !Number.isInteger(rawEstimate) || rawEstimate < 1 || rawEstimate > MAX_ESTIMATED_TOKENS) {
        throw new Error("Milestone " + (index + 1) + ": estimatedTokens должен быть целым от 1 до " + MAX_ESTIMATED_TOKENS + ".");
      }
      estimatedTokens = rawEstimate;
    }
    milestones.push({
      title,
      scope: text(value.scope, "scope", MAX_SCOPE, true),
      files: textList(value.files, "files", MAX_ITEM),
      tests: textList(value.tests, "tests", MAX_ITEM),
      definitionOfDone: text(value.definitionOfDone, "definitionOfDone", MAX_CHECK, true),
      ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
      status: status(value.status),
    });
  }

  const inProgress = milestones.filter(item => item.status === "in_progress");
  if (inProgress.length > 1) throw new Error("Milestone: только один этап может быть in_progress.");
  // A fresh all-pending plan gets its first current step. A plan that already has done work is a
  // checkpoint: promoting the next pending here would start a second milestone in the same run.
  if (!inProgress.length && milestones.every(item => item.status === "pending")) {
    milestones[0]!.status = "in_progress";
  }

  return {
    items: milestones.map(item => ({ title: item.title, status: item.status, note: item.scope })),
    milestones,
    updatedAt: new Date().toISOString(),
  };
}

/** The milestone this run is allowed to work on; a checkpoint has none. */
export function currentMilestone(plan: PlanState | undefined): Milestone | undefined {
  return plan?.milestones?.find(item => item.status === "in_progress");
}

/** The point a resumed run starts from: current, or the first pending after a checkpoint. */
export function resumeMilestone(plan: PlanState | undefined): Milestone | undefined {
  return currentMilestone(plan) ?? plan?.milestones?.find(item => item.status === "pending");
}

export function nextMilestone(plan: PlanState | undefined): Milestone | undefined {
  const current = plan?.milestones?.find(item => item.status === "in_progress");
  if (!current) return undefined;
  const index = plan!.milestones!.indexOf(current);
  return plan!.milestones!.slice(index + 1).find(item => item.status === "pending");
}

/** True when the current milestone is finished and the run must stop before starting another. */
export function milestoneCheckpoint(plan: PlanState | undefined): MilestoneCheckpoint {
  const milestones = plan?.milestones ?? [];
  if (!milestones.length) return { closed: false, allDone: false, completed: null, next: null };
  const current = milestones.find(item => item.status === "in_progress");
  const completed = [...milestones].reverse().find(item => item.status === "done") ?? null;
  const next = current
    ? milestones.slice(milestones.indexOf(current) + 1).find(item => item.status === "pending") ?? null
    : milestones.find(item => item.status === "pending") ?? null;
  return {
    closed: !current,
    allDone: milestones.every(item => item.status === "done"),
    completed,
    next,
  };
}

/**
 * The runtime decision after a plan update: did this call finish the run's milestone, either by
 * clearing the current step or by moving `in_progress` to another milestone in the same update?
 * The second case is a resume transition persisted for the next run, not permission to continue.
 */
export function milestoneTransition(previous: PlanState | undefined, next: PlanState) {
  const checkpoint = milestoneCheckpoint(next);
  const before = currentMilestone(previous);
  const after = currentMilestone(next);
  const advanced = Boolean(before && after && before.title !== after.title);
  return { closed: checkpoint.closed || advanced, advanced, checkpoint };
}

export function milestoneProgress(plan: PlanState | undefined) {
  const milestones = plan?.milestones ?? [];
  return { done: milestones.filter(item => item.status === "done").length, total: milestones.length };
}

/**
 * A compact view for the working-state block. It is deliberately bounded: the full milestone
 * object is in the plan, and repeating every file in every step would spend the context budget.
 */
export function milestoneStateLines(plan: PlanState | undefined): string[] {
  const milestone = resumeMilestone(plan);
  if (!milestone) {
    const allDone = Boolean(plan?.milestones?.length) && plan!.milestones!.every(item => item.status === "done");
    return allDone ? ["Milestone: все этапы отмечены готовыми."] : [];
  }
  const progress = milestoneProgress(plan);
  const lines = [
    "Milestone " + (progress.done + 1) + "/" + progress.total + " (" + milestone.status + "): " + milestone.title,
    "Scope: " + milestone.scope,
    "Files: " + milestone.files.join(", "),
    "Tests: " + milestone.tests.join("; "),
    "Definition of done: " + milestone.definitionOfDone,
  ];
  if (milestone.estimatedTokens) lines.push("Budget estimate: ~" + milestone.estimatedTokens + " tokens.");
  lines.push("Один запуск = один milestone. Заверши текущий, отметь его done через plan.milestones и остановись; следующий этап начнётся в новом запуске.");
  return lines;
}

/** Delivered after the milestone is closed so the model finishes rather than starting the next one. */
export function milestoneCheckpointNotice(plan: PlanState | undefined): string {
  const checkpoint = milestoneCheckpoint(plan);
  if (checkpoint.allDone) {
    return "MILESTONE CHECKPOINT: every milestone is done. The task is complete only after the normal verification; summarize the result and finish. Do not start new work.";
  }
  const completed = checkpoint.completed?.title ?? "current milestone";
  const next = checkpoint.next?.title;
  return "MILESTONE CHECKPOINT: «" + completed + "» is done. This run must stop changing the project here; " +
    (next ? "the next milestone «" + next + "» starts in a new run." : "there is no next milestone.") +
    " Do not start the next milestone, do not edit files, and do not replace the milestone plan. Summarize what is done and finish so the user can resume.";
}
