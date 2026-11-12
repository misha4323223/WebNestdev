import type { ScenarioPoint } from "../../qa/scenario-planner.js";

/** Сколько шагов разрешено в одном сценарии. Больше не значит «бесконечно»: это защита от JSON. */
export const MAX_SCENARIO_STEPS = 80;
/** Сколько шагов разрешено в setup-блоке до основного сценария. */
export const MAX_SETUP_STEPS = 40;
export const DEFAULT_STEP_TIMEOUT_MS = 5_000;
export const DEFAULT_SCENARIO_TIMEOUT_MS = 120_000;
export const MAX_STEP_TIMEOUT_MS = 120_000;
export const MAX_SCENARIO_TIMEOUT_MS = 600_000;
export const MAX_DRAG_STEPS = 40;
export const MAX_WAIT_MS = 60_000;

export type WaitState = "attached" | "detached" | "visible" | "hidden";

/**
 * Шаги браузерного сценария. Это не только клики: игры и canvas-приложения требуют координат,
 * touch-событий, пауз на анимацию и проверок состояния, а не только текста на странице.
 */
export type BrowserScenarioStep =
  | { action: "goto"; path: string; timeoutMs?: number }
  | { action: "click"; selector: string; force?: boolean; touch?: boolean; timeoutMs?: number }
  | { action: "tap"; selector: string; force?: boolean; timeoutMs?: number }
  | { action: "clickAt"; x: number; y: number; touch?: boolean; timeoutMs?: number }
  | { action: "fill"; selector: string; value: string; force?: boolean; timeoutMs?: number }
  | { action: "hover"; selector: string; force?: boolean; timeoutMs?: number }
  | { action: "longPress"; selector: string; durationMs?: number; touch?: boolean; timeoutMs?: number }
  | { action: "press"; selector?: string; key: string; holdMs?: number; timeoutMs?: number }
  | { action: "expectText"; text: string; timeoutMs?: number }
  | { action: "expectUrl"; pattern: string; timeoutMs?: number }
  | { action: "expectVisible"; selector: string; timeoutMs?: number }
  | { action: "expectNotVisible"; selector: string; timeoutMs?: number }
  | { action: "expectAttribute"; selector: string; name: string; value?: string; timeoutMs?: number }
  | { action: "expectCount"; selector: string; count: number; timeoutMs?: number }
  | { action: "expectValue"; selector: string; value: string; timeoutMs?: number }
  | { action: "waitForSelector"; selector: string; state?: WaitState; timeoutMs?: number }
  | { action: "waitForNetworkIdle"; timeoutMs?: number }
  | { action: "waitForFunction"; expression: string; arg?: unknown; timeoutMs?: number }
  | { action: "wait"; ms: number }
  | { action: "setLocalStorage"; values: Record<string, string> }
  | { action: "drag"; from: ScenarioPoint; to: ScenarioPoint; steps?: number; touch?: boolean; timeoutMs?: number }
  | {
    action: "screenshot";
    name?: string;
    fullPage?: boolean;
    selector?: string;
    /** Сравнить с baseline и вернуть changed/same. */
    baseline?: boolean;
    /** Перезаписать baseline текущим кадром. */
    updateBaseline?: boolean;
    timeoutMs?: number;
  }
  | {
    action: "expectScreenshot";
    name?: string;
    selector?: string;
    baseline?: boolean;
    updateBaseline?: boolean;
    timeoutMs?: number;
  };

export type BrowserScenarioInput = {
  path?: string;
  viewport?: unknown;
  timeoutMs?: number;
  /** Сбросить счётчик неудачных browser.scenario в текущем запуске агента. */
  resetAttempts?: boolean;
  /** Синоним resetAttempts: явный повтор после серии неудач. */
  retry?: boolean;
  /** Значения localStorage, которые должны существовать до первого скрипта приложения. */
  storage?: Record<string, string>;
  /** Подготовка до основных шагов: заполнить storage, дождаться ready, открыть нужный экран. */
  setup?: BrowserScenarioStep[];
  steps?: BrowserScenarioStep[];
};

export type OverlapInfo = {
  point: { x: number; y: number };
  target?: {
    selector: string;
    tag: string;
    id: string;
    classes: string;
    zIndex: string;
    pointerEvents: string;
    rect: { x: number; y: number; width: number; height: number };
    text: string;
  };
  /** Что реально находится в центре элемента: обычно декоративный слой или прозрачная маска. */
  top?: {
    tag: string;
    id: string;
    classes: string;
    zIndex: string;
    pointerEvents: string;
    rect: { x: number; y: number; width: number; height: number };
    text: string;
  };
  stack: Array<{ tag: string; id: string; classes: string; zIndex: string; pointerEvents: string }>;
  sameElement: boolean;
};

export type StepDiagnostics = {
  console?: Array<{ text: string; url?: string }>;
  pageErrors?: string[];
  failedRequests?: Array<{ url: string; error: string }>;
  httpErrors?: Array<{ url: string; status: number }>;
};

export type ScenarioStepResult = {
  step: number;
  phase: "setup" | "scenario";
  action: string;
  ok: boolean;
  /** Полный хвост сообщения Playwright, последние 40 строк без обрезки строк. */
  detail?: string;
  /** Последние 40 строк call log отдельным полем, чтобы его не съел общий лимит JSON. */
  callLog?: string;
  screenshot?: import("../screenshot-file.js").SavedScreenshot;
  layout?: import("../screenshot-file.js").LayoutAudit;
  overlap?: OverlapInfo;
  diagnostics?: StepDiagnostics;
  expectation?: {
    kind: string;
    actual?: unknown;
    expected?: unknown;
    baseline?: BaselineResult;
  };
  baseline?: BaselineResult;
};

export type BaselineResult = {
  path: string;
  bytes: number;
  changed: boolean;
  created: boolean;
  hash: string;
  /** Пиксельное сравнение: сколько точек изменилось, а не только «байты не совпали». */
  diff?: {
    path: string;
    changedPixels: number;
    totalPixels: number;
    ratio: number;
    width: number;
    height: number;
  };
};

export type BrowserScenarioDeps = {
  now?: () => number;
  /** Тест может подменить Chromium; production оставляет настоящий. */
  launch?: typeof import("playwright").chromium.launch;
};
