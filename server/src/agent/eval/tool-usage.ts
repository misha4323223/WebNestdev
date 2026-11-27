/**
 * Учёт вызовов инструментов в eval: какие инструменты агент реально позвал и совпало ли это
 * с ожиданиями задачи (`mustCall` / `mustNotCall`).
 *
 * Зачем отдельный модуль: без этих чисел спор «инструмент не выдан или модель его не вызвала»
 * решается догадками, а любая правка каталога или промта проверяется только глазами. Здесь
 * только подсчёт и сверка с политикой задачи — приговор задаче по-прежнему выносит адаптер
 * (`observation.ok`), чтобы метрика успеха не смешивалась с дисциплиной вызова.
 */
export type EvalToolCall = { name: string; count: number };

export type EvalToolPolicy = {
  mustCall?: readonly string[];
  mustNotCall?: readonly string[];
};

export type EvalToolPolicyOutcome = {
  required: string[];
  forbidden: string[];
  /** Обязательные инструменты, которые ни разу не вызваны. */
  missing: string[];
  /** Запрещённые инструменты, которые всё-таки вызваны. */
  forbiddenCalled: string[];
  /** Политика выполнена: ничего не забыто и ничего лишнего не вызвано. */
  satisfied: boolean;
  /** Фактические вызовы, по убыванию частоты. */
  calls: EvalToolCall[];
};

/**
 * Схлопывает список вызовов в счётчики. Порядок — по частоте, затем по имени: отчёт не должен
 * зависеть от порядка, в котором адаптер прислал события.
 */
export function summarizeToolCalls(names: readonly string[]): EvalToolCall[] {
  const counts = new Map<string, number>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function unique(names: readonly string[] | undefined) {
  return [...new Set((names ?? []).map(name => name.trim()).filter(Boolean))];
}

/** Сверка фактических вызовов с политикой задачи. Пустая политика всегда выполнена. */
export function checkToolPolicy(
  calls: readonly EvalToolCall[],
  policy: EvalToolPolicy = {},
): EvalToolPolicyOutcome {
  const required = unique(policy.mustCall);
  const forbidden = unique(policy.mustNotCall);
  const called = new Set(calls.map(call => call.name));
  const missing = required.filter(name => !called.has(name));
  const forbiddenCalled = forbidden.filter(name => called.has(name));
  return {
    required,
    forbidden,
    missing,
    forbiddenCalled,
    satisfied: missing.length === 0 && forbiddenCalled.length === 0,
    calls: [...calls],
  };
}

/** Есть ли у задачи вообще политика: без неё в отчёте не появляется строка «проверено». */
export function hasToolPolicy(policy: EvalToolPolicy = {}): boolean {
  return unique(policy.mustCall).length > 0 || unique(policy.mustNotCall).length > 0;
}

/** Короткая строка для отчёта: «ok» или что именно нарушено. */
export function describeToolPolicy(outcome: EvalToolPolicyOutcome | undefined): string {
  if (!outcome) return "—";
  const parts: string[] = [];
  if (outcome.missing.length) parts.push("не вызваны: " + outcome.missing.join(", "));
  if (outcome.forbiddenCalled.length) parts.push("лишние: " + outcome.forbiddenCalled.join(", "));
  return parts.length ? parts.join("; ") : "ok";
}
