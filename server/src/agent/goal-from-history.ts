/**
 * Цель запуска не должна становиться словом «продолжай».
 *
 * Рабочее состояние строилось из последней реплики, поэтому после «продолжай» модель видела
 * цель «продолжай», а не задачу, которую продолжает. План это частично компенсировал, но не
 * заменял: план говорит «что делать», цель — «зачем».
 *
 * Здесь только выбор текста: если реплика — короткое продолжение и есть незавершённый план,
 * целью становится предыдущая содержательная просьба пользователя из истории. Ничего не
 * хранится в базе и не переписывает историю.
 */
const CONTINUATION_WORDS = new Set([
  "продолжай", "продолжи", "продолжаем", "дальше", "да", "давай", "ок", "окей", "хорошо",
  "поехали", "погнали", "continue", "carry", "go", "yes", "ok", "okay", "next",
]);

/**
 * Короткое «продолжай/да/ок» — знак продолжать, а не новая задача. Ограничение по числу слов
 * важно: «продолжай работу над оплатой» уже называет тему и должно остаться целью само по себе.
 */
export function isContinuation(task: string): boolean {
  const words = task.trim().toLowerCase().replace(/[.,!?…]+$/g, "").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return CONTINUATION_WORDS.has(words[0] ?? "");
}

export function resolveObjective(input: {
  task: string;
  previousUserMessages: readonly string[];
  hasActivePlan: boolean;
}): string {
  const task = input.task.trim();
  if (!task) return input.previousUserMessages.at(-1)?.trim() || "продолжить работу над проектом";
  if (!input.hasActivePlan || !isContinuation(task)) return task;
  const previous = [...input.previousUserMessages]
    .reverse()
    .map(message => message.trim())
    .find(message => message && !isContinuation(message));
  return previous ?? task;
}
