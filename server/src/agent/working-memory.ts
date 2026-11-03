import type { ChatMessage, PlanState } from "../types.js";
import { clip } from "./context-budget.js";

/**
 * The state of the current run, kept outside the message log.
 *
 * A long chat is a bad place for the few facts every next step depends on: after a cut the model
 * sees a digest of old turns, and its own plan may be buried under tool output. This block is
 * appended as the last system message before every model call, so the goal, the plan, the files
 * already changed and the checks already passed are always in front of the model — while the
 * prefix of the prompt stays byte-for-byte stable for DeepSeek's cache.
 */
export type WorkingMemory = {
  objective: string;
  plan?: PlanState;
  /** The plan was restored from a previous run; a new task should replace it. */
  planFromPreviousRun: boolean;
  changed: Map<string, string>;
  checks: string[];
};

export const WORKING_STATE_PREFIX = "[ТЕКУЩЕЕ СОСТОЯНИЕ]";
const MAX_OBJECTIVE_CHARS = 1_200;
const MAX_PLAN_ITEMS = 24;
const MAX_PLAN_TITLE_CHARS = 140;
const MAX_CHANGED_PATHS = 12;
const MAX_CHECK_LINES = 8;
const MAX_STATE_CHARS = 6_000;

const STATUS_LABEL: Record<PlanState["items"][number]["status"], string> = {
  done: "готово",
  in_progress: "сейчас",
  pending: "ждёт",
};

export function createWorkingMemory(objective: string, plan?: PlanState): WorkingMemory {
  return {
    objective: clip(objective.trim(), MAX_OBJECTIVE_CHARS - 200, 200, "цель сокращена") || "продолжить работу над проектом",
    ...(plan ? { plan } : {}),
    planFromPreviousRun: false,
    changed: new Map(),
    checks: [],
  };
}

/** A plan published by the model, or one restored from the previous run. */
export function setWorkingPlan(memory: WorkingMemory, plan: PlanState, fromPreviousRun = false) {
  memory.plan = plan;
  memory.planFromPreviousRun = fromPreviousRun;
}

/**
 * File changes are kept newest-first and bounded: a run that edits forty files should not turn the
 * memory block into a second changelog.
 */
export function recordWorkingChange(memory: WorkingMemory, path: string, summary: string) {
  const value = path.replace(/^\.\//, "").trim();
  if (!value) return;
  memory.changed.delete(value);
  memory.changed.set(value, summary.trim());
  while (memory.changed.size > MAX_CHANGED_PATHS) {
    const oldest = memory.changed.keys().next().value;
    if (oldest === undefined) break;
    memory.changed.delete(oldest);
  }
}

/** A successful check is a fact for every following step; a repeated one replaces itself. */
export function recordWorkingCheck(memory: WorkingMemory, label: string) {
  const value = label.trim();
  if (!value) return;
  memory.checks = [...memory.checks.filter(item => item !== value), value].slice(-MAX_CHECK_LINES);
}

/**
 * One check owns one line: `сборка: пройдена` is replaced by `сборка: ошибка` after a later failed
 * build, instead of the stale success sitting next to the fresh failure.
 */
export function setWorkingCheck(memory: WorkingMemory, key: string, value: string) {
  const prefix = key.trim() + ":";
  memory.checks = [
    ...memory.checks.filter(item => !item.startsWith(prefix)),
    prefix + " " + value.trim(),
  ].slice(-MAX_CHECK_LINES);
}

function planLines(plan: PlanState) {
  const lines: string[] = [];
  for (const [index, item] of plan.items.slice(0, MAX_PLAN_ITEMS).entries()) {
    const titleText = typeof item.title === "string" ? item.title : "";
    const noteText = typeof item.note === "string" ? item.note : "";
    const title = clip(titleText.replace(/\s+/g, " ").trim(), MAX_PLAN_TITLE_CHARS - 30, 30, "пункт сокращён") || "пункт без названия";
    const note = noteText.trim() ? " — " + clip(noteText.replace(/\s+/g, " ").trim(), 100, 20, "заметка сокращена") : "";
    lines.push((index + 1) + ". [" + (STATUS_LABEL[item.status] ?? item.status) + "] " + title + note);
  }
  if (plan.items.length > MAX_PLAN_ITEMS) lines.push("…ещё " + (plan.items.length - MAX_PLAN_ITEMS) + " пунктов плана");
  return lines;
}

/**
 * The text the model reads before each step. It is deliberately factual and short: this is not a
 * second system prompt, it is the run's clipboard.
 */
export function workingStateText(memory: WorkingMemory) {
  const lines = [
    WORKING_STATE_PREFIX,
    "Память текущего запуска. Она обновляется после каждого шага: опирайся на неё и не начинай анализ задачи заново.",
    "Цель: " + memory.objective,
  ];
  const plan = memory.plan;
  if (plan?.items.length) {
    const header = memory.planFromPreviousRun
      ? "План (сохранён с прошлого этапа; если задача новая — замени его):"
      : plan.items.some(item => item.status === "in_progress")
        ? "План:"
        : "План (все пункты отмечены готовыми; если это не так — обнови статусы):";
    lines.push(header);
    lines.push(...planLines(plan));
  } else {
    lines.push("План: пока не опубликован. Если задача многошаговая, опубликуй его через plan.update и поддерживай статусы.");
  }
  const current = plan?.items.find(item => item.status === "in_progress");
  if (current) lines.push("Сейчас: " + clip(typeof current.title === "string" ? current.title : "", MAX_PLAN_TITLE_CHARS - 30, 30, "пункт сокращён"));
  const next = plan?.items.find(item => item.status === "pending");
  if (next) lines.push("Следующий шаг: " + clip(typeof next.title === "string" ? next.title : "", MAX_PLAN_TITLE_CHARS - 30, 30, "пункт сокращён"));
  if (memory.changed.size) {
    lines.push("Уже изменено:");
    for (const [path, summary] of memory.changed) lines.push("- " + path + (summary ? " — " + summary : ""));
  }
  if (memory.checks.length) lines.push("Уже проверено: " + memory.checks.join("; "));
  lines.push("Не повторяй уже сделанное. Если факта не хватает, прочитай нужный файл или запусти проверку, а не пересказывай задачу заново.");
  const text = lines.join("\n");
  // The block is re-sent on every step, so it must never grow without a bound. The tail is the
  // actionable part, so the cut keeps both ends.
  return text.length <= MAX_STATE_CHARS ? text : clip(text, MAX_STATE_CHARS - 800, 800, "рабочее состояние сокращено");
}

/**
 * Replaces the previous state block instead of appending another one. Everything before it stays
 * identical, so a prompt-cache prefix hit is preserved; only the tail that changes every step moves.
 */
export function withWorkingState(messages: ChatMessage[], memory: WorkingMemory): ChatMessage[] {
  const clean = messages.filter(message => !(message.role === "system" && message.content.startsWith(WORKING_STATE_PREFIX)));
  return [...clean, { role: "system", content: workingStateText(memory) }];
}
