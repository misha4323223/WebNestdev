/**
 * Сигнал «форма без бэкенда».
 *
 * Самая частая имитация: разметка формы есть, обработчик показывает «Спасибо, заявка отправлена»,
 * а данных не получает никто. Ни консоль, ни проверка отрисовки об этом не говорят — страница
 * работает, кнопка нажимается. Поэтому файлы проекта просматриваются отдельно, и `project.verify`
 * возвращает этот факт: заявки не придут, пока не подключён приёмник.
 */

export type FormSource = { path: string; text: string };

export type FormSignal = {
  /** В проекте есть разметка формы или обработчик отправки. */
  found: boolean;
  /** Файлы, где эта разметка найдена. */
  files: string[];
  /** Куда форма отправляет данные по разметке (`action`); пусто — адреса нет. */
  submitsTo: string[];
  /** Сетевые вызовы в проекте: fetch, XHR, sendBeacon, вебхук известных приёмников. */
  networkCalls: string[];
  /** Форма есть, а отправлять некуда: это имитация. */
  simulated: boolean;
  note: string;
};

const FORM_MARKUP = /<form\b|type\s*=\s*["']submit["']|onsubmit\s*=|addEventListener\s*\(\s*["']submit["']/i;
const FORM_ACTION = /<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/gi;
const NETWORK_CALL = /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|\baxios\b|\$\.(?:post|ajax)\s*\(|formspree|getform|api\.telegram\.org|discord(?:app)?\.com\/api\/webhooks|\/api\//i;

/** Подсказка пользователю: чем заменить имитацию, не строя собственный бэкенд. */
export const FORM_SIMULATION_HINT =
  "Форма работает в режиме имитации: заявки никуда не уходят. В «Интеграциях» → «Сервисы» для этого есть CRM (RetailCRM, Битрикс24, amoCRM — входящий вебхук) и почта (NotiSend, Sendsay, Unisender): подключите карточку, возьмите адрес из её настроек и отправьте на него fetch из обработчика формы.";

export function analyzeForms(sources: FormSource[]): FormSignal {
  const files: string[] = [];
  const submitsTo: string[] = [];
  const networkCalls: string[] = [];

  for (const source of sources) {
    if (FORM_MARKUP.test(source.text)) files.push(source.path);
    for (const match of source.text.matchAll(FORM_ACTION)) {
      const action = (match[1] ?? "").trim();
      // `action=""` и `action="#"` — не адрес, а заглушка: так форма и остаётся имитацией.
      if (action && action !== "#" && !action.startsWith("#")) submitsTo.push(source.path + ": " + action.slice(0, 200));
    }
    if (NETWORK_CALL.test(source.text) && !networkCalls.includes(source.path)) networkCalls.push(source.path);
  }

  const found = files.length > 0;
  const simulated = found && submitsTo.length === 0 && networkCalls.length === 0;
  return {
    found,
    files,
    submitsTo,
    networkCalls,
    simulated,
    note: !found
      ? "Форм в проекте нет."
      : simulated
        ? FORM_SIMULATION_HINT
        : "Форма отправляет данные: " +
          (submitsTo.length ? "адрес из разметки — " + submitsTo.join(", ") : "в проекте есть сетевой вызов — " + networkCalls.join(", ")) +
          ".",
  };
}
