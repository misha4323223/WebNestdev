/**
 * Мягкий предел шагов и детектор «топтания на месте».
 *
 * Предел шагов (`agentStepLimit`) нужен: без него одна задача могла бы жечь кредиты бесконечно.
 * Но ошибка — плохой финал для работы, которая почти закончена. Поэтому последний шаг — отчёт
 * (`stepLimitNotice`): инструменты выключаются, модель пишет «сделано / осталось / дальше», а
 * запуск завершается успешно и продолжается с этого же места по слову пользователя.
 *
 * Поэтому здесь два независимых предохранителя, оба без нового «жёсткого» поведения:
 *
 * 1. `softStepLimit` — момент, когда модели один раз говорят: шаги на исходе, заканчивай
 *    результат и проверку, а не начинай новое исследование. Решение остаётся за моделью.
 * 2. `createProgressDetector` — повтор одного и того же вызова с теми же аргументами несколько
 *    шагов подряд. Успешный повтор ничего не меняет, и модель застревает в нём, считая, что
 *    «проверяет». Детектор возвращает готовую заметку, а не останавливает запуск: иногда повтор
 *    законен (внешний сервис поднялся), и об этом модель должна решить сама.
 *
 * Оба текста — системные сообщения для модели, английские, как остальные заметки рантайма.
 */

export const DEFAULT_SOFT_STEP_RATIO = 0.8;

/** Доля жёсткого предела, на которой звучит предупреждение. `0.8` — то есть 32 из 40 шагов. */
export function softStepRatio(): number {
  const raw = Number(process.env.AGENT_SOFT_STEP_RATIO);
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1) return DEFAULT_SOFT_STEP_RATIO;
  return raw;
}

/** Шаг, на котором модель получает предупреждение. Никогда не равен жёсткому пределу. */
export function softStepLimit(maxSteps: number, ratio = softStepRatio()): number {
  const limit = Math.max(1, Math.floor(maxSteps));
  const soft = Math.floor(limit * ratio);
  return Math.min(Math.max(1, soft), Math.max(1, limit - 1));
}

export function softStepNotice(step: number, maxSteps: number): string {
  return "SOFT STEP LIMIT: step " + step + " of " + maxSteps + ". At the limit the run stops with a saved summary " +
    "and continues from the same place when the user says so, so finish a complete, verified result now. " +
    "Do not start new exploration: make the smallest change that " +
    "satisfies the task, run the verification you already know is needed, and answer the user. If the task " +
    "cannot be finished in the remaining steps, say exactly what is done, what is left, and what you would do next.";
}

/**
 * Заметка последнего шага. Раньше предел заканчивал запуск ошибкой, и модель узнавала об этом,
 * только когда шаги уже кончились. Теперь последний шаг — отчёт: инструменты отключены, работа
 * сохранена, а продолжение начинается с этого же места по слову пользователя.
 */
export function stepLimitNotice(step: number, maxSteps: number): string {
  return "STEP LIMIT: step " + step + " of " + maxSteps + " is the last step of this run, and tools are disabled for it. " +
    "Do not start new work and do not claim anything you did not verify. Answer the user in their language with " +
    "what is already done (naming the checks that passed), what is left, and the exact next action. " +
    "Say that the work and its context are saved, and that saying «продолжай» continues from this exact point. " +
    "Do not ask the user to repeat the task.";
}

/** Ответ, если модель на последнем шаге не написала ничего: человек всё равно должен знать, что делать. */
export function stepLimitAnswer(): string {
  return "На этот запуск закончились шаги — вся работа и контекст сохранены. Напишите «продолжай», и я продолжу с этого места.";
}

export type ProgressCall = { name: string; arguments?: unknown };

function callSignature(call: ProgressCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.arguments ?? {});
  } catch {
    args = String(call.arguments);
  }
  return call.name + "\u0000" + args.slice(0, 1200);
}

/** Подпись шага: набор вызовов без порядка. Порядок чтения файлов не делает шаг новым. */
export function stepSignature(calls: ProgressCall[]): string {
  return calls.map(callSignature).sort().join("\u0001");
}

export type ProgressDetector = {
  /** Возвращает заметку, если шаг повторяет предыдущие, иначе `null`. */
  observe: (calls: ProgressCall[]) => string | null;
  reset: () => void;
  /** Сколько шагов подряд повторяется одна и та же подпись (для тестов и логов). */
  repeats: () => number;
};

/**
 * Считает подряд идущие шаги с одинаковым набором вызовов. Порог по умолчанию — три шага: один
 * повтор бывает нормальным (повторная проверка после правки), три подряд — уже застревание.
 * Шаг без вызовов (модель отвечает) сбрасывает счётчик: работа закончилась, а не застряла.
 */
export function createProgressDetector(options: { repeatThreshold?: number; windowSize?: number } = {}): ProgressDetector {
  const threshold = Math.max(2, Math.floor(options.repeatThreshold ?? 3));
  // Окно нужно для чередования: A, B, A, B не повторяет один и тот же шаг подряд, но так же
  // не двигает работу. Восемь шагов хватает, чтобы отличить цикл от пары «правка → проверка».
  const windowSize = Math.max(4, Math.floor(options.windowSize ?? 8));
  let previous = "";
  let count = 0;
  let window: string[] = [];
  let alternatingNotified = false;
  const clear = () => {
    previous = "";
    count = 0;
    window = [];
    alternatingNotified = false;
  };
  return {
    observe(calls) {
      if (!calls.length) {
        clear();
        return null;
      }
      const signature = stepSignature(calls);
      if (signature === previous) {
        count++;
      } else {
        previous = signature;
        count = 1;
      }
      window.push(signature);
      if (window.length > windowSize) window.shift();
      const alternating = window.length >= 4 && (() => {
        const [first, second, third, fourth] = window.slice(-4);
        return first === third && second === fourth && first !== second;
      })();
      if (alternating && !alternatingNotified) {
        // Одна заметка на серию: если модель продолжает цикл, повтор предупреждения только
        // тратит контекст, а смена действий снова включает детектор.
        alternatingNotified = true;
        count = 0;
        previous = "";
        return "NO PROGRESS: the last steps alternate between the same two actions instead of moving forward. " +
          "This loop produces no new information. Read the actual output of one of them, change the approach, " +
          "or stop and name the blocker for the user instead of alternating again.";
      }
      if (!alternating) alternatingNotified = false;
      if (count < threshold) return null;
      // Заметка уходит один раз на серию: повторять её каждый шаг значило бы тратить контекст
      // на одно и то же предупреждение вместо работы.
      count = 0;
      previous = "";
      return "NO PROGRESS: the last " + threshold + " steps called the same tools with the same arguments and " +
        "produced no new information. Repeating them will not change the result. Re-read the actual output, " +
        "choose a different approach, or stop and name the blocker for the user instead of retrying.";
    },
    reset: clear,
    repeats() {
      return count;
    },
  };
}
