/**
 * JSON Schema инструмента живёт отдельно от движка: у сценария много действий, и его контракт
 * должен читаться моделью без чтения реализации.
 */
const point = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: { x: { type: "number" }, y: { type: "number" } },
};

const scenarioStepProperties: Record<string, unknown> = {
  action: {
    type: "string",
    enum: [
      "goto", "click", "tap", "clickAt", "fill", "hover", "longPress", "press",
      "expectText", "expectUrl", "expectVisible", "expectNotVisible", "expectAttribute",
      "expectCount", "expectValue", "waitForSelector", "waitForNetworkIdle", "waitForFunction",
      "wait", "setLocalStorage", "drag", "screenshot", "expectScreenshot",
    ],
  },
  path: { type: "string", description: "Для goto: маршрут предпросмотра" },
  selector: { type: "string", description: "CSS-селектор цели действия" },
  value: { type: "string", description: "Значение для fill/expectAttribute/expectValue" },
  key: { type: "string", description: "Клавиша для press, например Enter или Space" },
  text: { type: "string", description: "Ожидаемый текст для expectText" },
  pattern: { type: "string", description: "Регулярное выражение URL для expectUrl" },
  name: { type: "string", description: "Имя baseline/скриншота" },
  x: { type: "number", description: "Координата x для clickAt" },
  y: { type: "number", description: "Координата y для clickAt" },
  state: { type: "string", enum: ["attached", "detached", "visible", "hidden"], description: "Состояние для waitForSelector" },
  expression: { type: "string", description: "JS-выражение для waitForFunction" },
  arg: { description: "Аргумент waitForFunction (JSON-значение)" },
  count: { type: "number", description: "Ожидаемое количество для expectCount" },
  ms: { type: "number", description: "Пауза в миллисекундах для wait" },
  durationMs: { type: "number", description: "Длительность longPress в миллисекундах" },
  holdMs: { type: "number", description: "Удержание клавиши/кнопки в миллисекундах для press" },
  timeoutMs: { type: "number", description: "Таймаут шага; по умолчанию 5000" },
  force: { type: "boolean", description: "Клик/наведение в обход actionability (click, tap, fill, hover)" },
  touch: { type: "boolean", description: "Настоящие touch-события для click/tap/clickAt/longPress/drag" },
  fullPage: { type: "boolean", description: "Снимать страницу целиком для screenshot" },
  baseline: { type: "boolean", description: "Сравнить screenshot с baseline" },
  updateBaseline: { type: "boolean", description: "Перезаписать baseline текущим кадром" },
  from: { ...point, description: "Начальная точка drag" },
  to: { ...point, description: "Конечная точка drag" },
  steps: { type: "number", description: "Промежуточных pointermove для drag (1–40)" },
  values: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Ключи localStorage для setLocalStorage",
  },
};

const stepSchema = {
  type: "object",
  required: ["action"],
  properties: scenarioStepProperties,
};

export const browserScenarioParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Маршрут предпросмотра, с которого начинается сценарий; по умолчанию /" },
    viewport: { type: "string", enum: ["desktop", "tablet", "mobile"], description: "Размер окна: desktop 1440×900, tablet 820×1180, mobile 390×844; mobile включает hasTouch/isMobile" },
    timeoutMs: { type: "number", description: "Общий таймаут сценария в миллисекундах; по умолчанию 120000" },
    resetAttempts: { type: "boolean", description: "Сбросить лимит трёх неудачных browser.scenario и продолжить в этом же запуске" },
    retry: { type: "boolean", description: "Синоним resetAttempts для явного повтора после серии неудач" },
    storage: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "localStorage до первого скрипта приложения",
    },
    setup: {
      type: "array",
      maxItems: 40,
      description: "Подготовка до основных шагов: storage, ready-событие, открытие экрана",
      items: stepSchema,
    },
    steps: {
      type: "array",
      maxItems: 80,
      description: "Основные шаги; выполнение останавливается на первом неудачном",
      items: stepSchema,
    },
  },
} as const;

export const browserScenarioDescription =
  "Run a real Chromium user-flow scenario against Preview. Supports DOM actions (click/tap/clickAt, fill, hover, press with holdMs, longPress, drag with touch), waits (waitForSelector/NetworkIdle/Function, wait), assertions (text/url/visible/attribute/count/value), localStorage setup, screenshots with baseline comparison, and up to 80 steps. Each step and the whole scenario accept timeoutMs. On timeout the failed step contains the full last 40 lines of the Playwright call log, an elementFromPoint/overlap diagnosis for clicks, console/network diagnostics for that step, and an automatic failure PNG. It stops on the first failed step and reports rendered page evidence, blank screen, HTTP/network errors; app 4xx and aborted requests stay in `background`, not in failures.";

export const browserRuntimeParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", description: "Маршрут предпросмотра, например / или /about; по умолчанию /" },
    viewport: { type: "string", enum: ["desktop", "tablet", "mobile"], description: "Размер окна проверки: desktop 1440×900, tablet 820×1180, mobile 390×844" },
  },
} as const;
