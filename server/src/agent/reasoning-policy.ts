import type { AgentMode, ReasoningEffort, ReasoningMode } from "../types.js";
import { looksLikeProductBuild } from "./task-scale.js";

/**
 * Насколько глубоко думать на конкретном шаге.
 *
 * `auto` не пытается угадать «сложность модели» отдельным вызовом — это стоило бы ещё одного
 * запроса. Решение принимается по уже известным фактам: первый шаг, номер шага, длина и характер
 * задачи, повторные ошибки проверки. Явный выбор пользователя всегда важнее автоматики.
 */
export type ReasoningPolicyInput = {
  requested: ReasoningMode;
  step: number;
  task: string;
  mode?: AgentMode;
  /** Сколько раз подряд не прошла проверка к моменту этого шага. */
  verificationFailures?: number;
  /** Сколько файлов уже изменено: после начала работы рутина дешевле. */
  changedFiles?: number;
  /** Сколько шагов в опубликованном плане: большой план держит глубину дольше. */
  planItems?: number;
  resumed?: boolean;
};

const COMPLEX_TASK_RE = /(архитектур|рефактор|миграц|безопасн|производительн|оптимиз|сложн|баг|ошибк|тест|деплой|интеграц|api|database|auth|authentication|performance|security|migration|refactor|debug)/i;

function isComplexTask(task: string) {
  return task.trim().length > 600 || COMPLEX_TASK_RE.test(task);
}

/**
 * Конкретная глубина для провайдера. Возвращает только low/medium/high; `auto` сюда не попадает.
 */
export function resolveReasoning(input: ReasoningPolicyInput): ReasoningEffort {
  if (input.requested !== "auto") return input.requested;

  // Ошибка проверки — единственный сигнал, который важнее экономии: следующая попытка должна
  // разобраться в причине, а не повторять тот же поверхностный шаг.
  if ((input.verificationFailures ?? 0) > 0) return "high";

  const step = Math.max(1, Math.floor(input.step));
  const complex = isComplexTask(input.task);
  const planner = input.mode === "planner";

  if (step === 1) {
    if (input.resumed) return "high";
    if (complex) return "high";
    // «Сделай интернет-магазин с корзиной» — короткая реплика про большой продукт: low здесь
    // означал бы самый дешёвый разбор на всю сборку.
    if (!planner && looksLikeProductBuild(input.task)) return "medium";
    // Очень короткая механическая правка не требует длинной цепи рассуждений.
    if (!planner && input.task.trim().length <= 160) return "low";
    return "medium";
  }

  // После первого шага сложная задача ещё держит среднюю глубину, пока не появился изменённый
  // файл; дальше исполнение дешевле. Планировщик дольше остаётся на среднем уровне, потому что
  // его результат — сам план, а не правка.
  // Большой план — не рутина первого шага: пока шагов много и правок ещё нет, дешёвая
  // глубина приводит к повторным переделкам.
  if ((input.planItems ?? 0) >= 4 && step <= 3) return "medium";
  if (complex && (input.changedFiles ?? 0) === 0 && step <= 3) return "medium";
  if (planner && step <= 2) return "medium";
  return "low";
}
