import { chromium, type Browser, type Page } from "playwright";
import { previewStatus } from "../../preview-manager.js";
import { getPreview } from "../../preview/preview-store.js";
import { getSandbox } from "../../sandbox/sandbox-service.js";
import { BROWSER_VIEWPORTS, readBrowserViewport } from "../browser-viewport.js";
import { readLayout, saveScreenshot, type LayoutAudit, type SavedScreenshot } from "../screenshot-file.js";
import {
  classifyRuntimeFailures,
  loadAndSettle,
  readPageEvidence,
  type ConsoleMessage,
} from "../browser-evidence.js";
import {
  clampPoint,
  dragOnPage,
  inspectOverlap,
  longPressOnPage,
  overlapSummary,
  playwrightDetail,
  poll,
  readMs,
  readPoint,
  readWaitMs,
  remainingMs,
  stepTimeoutMs,
  touchTapAt,
} from "./actions.js";
import { captureScenarioScreenshot } from "./screenshots.js";
import {
  DEFAULT_SCENARIO_TIMEOUT_MS,
  MAX_SCENARIO_STEPS,
  MAX_SCENARIO_TIMEOUT_MS,
  MAX_SETUP_STEPS,
  type BaselineResult,
  type BrowserScenarioDeps,
  type BrowserScenarioInput,
  type BrowserScenarioStep,
  type ScenarioStepResult,
  type StepDiagnostics,
} from "./types.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scenarioPath(value: unknown) {
  const path = typeof value === "string" && value.trim() ? value.trim() : "/";
  return path.startsWith("/") ? path : "/" + path;
}

function storageValues(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Читает вход без доверия к JSON: неизвестные поля не должны ронять весь сценарий. */
export function readScenarioInput(input: unknown): BrowserScenarioInput {
  const value = isObject(input) ? input : {};
  const setup = Array.isArray(value.setup)
    ? value.setup.slice(0, MAX_SETUP_STEPS).filter(item => isObject(item)) as BrowserScenarioStep[]
    : [];
  const steps = Array.isArray(value.steps)
    ? value.steps.slice(0, MAX_SCENARIO_STEPS).filter(item => isObject(item)) as BrowserScenarioStep[]
    : [];
  const storage = storageValues(value.storage);
  return {
    path: scenarioPath(value.path),
    viewport: value.viewport,
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
    ...(storage ? { storage } : {}),
    setup,
    steps,
  };
}

function isTouchStep(step: BrowserScenarioStep) {
  return step.action === "tap" ||
    (step.action === "click" && step.touch === true) ||
    (step.action === "clickAt" && step.touch === true) ||
    (step.action === "longPress" && step.touch === true) ||
    (step.action === "drag" && step.touch === true);
}

function diagnosticsSince(input: {
  consoleErrors: ConsoleMessage[];
  pageErrors: string[];
  failedRequests: Array<{ url: string; error: string }>;
  httpErrors: Array<{ url: string; status: number }>;
  start: { console: number; page: number; failed: number; http: number };
}): StepDiagnostics {
  const result: StepDiagnostics = {};
  const console = input.consoleErrors.slice(input.start.console);
  const pageErrors = input.pageErrors.slice(input.start.page);
  const failedRequests = input.failedRequests.slice(input.start.failed);
  const httpErrors = input.httpErrors.slice(input.start.http);
  if (console.length) result.console = console;
  if (pageErrors.length) result.pageErrors = pageErrors;
  if (failedRequests.length) result.failedRequests = failedRequests;
  if (httpErrors.length) result.httpErrors = httpErrors;
  return result;
}

function hasDiagnostics(value: StepDiagnostics) {
  return Boolean(value.console?.length || value.pageErrors?.length || value.failedRequests?.length || value.httpErrors?.length);
}

async function waitForNetwork(page: Page, timeoutMs: number, deadline: number) {
  const left = remainingMs(deadline);
  if (left <= 0) return;
  await page.waitForLoadState("networkidle", { timeout: Math.min(2_000, Math.max(1, timeoutMs), left) }).catch(() => undefined);
}

async function runStep(input: {
  page: Page;
  projectId: string;
  baseUrl: string;
  step: BrowserScenarioStep;
  index: number;
  phase: "setup" | "scenario";
  deadline: number;
  ensureRoot: () => Promise<string | null>;
  documentStatus: () => number | null;
  setDocumentStatus: (value: number | null) => void;
}): Promise<ScenarioStepResult> {
  const { page, projectId, baseUrl, step, index, phase, deadline, ensureRoot } = input;
  const result: ScenarioStepResult = { step: index + 1, phase, action: step.action, ok: true };
  const timeout = stepTimeoutMs(step, deadline);
  // timeoutMs шага — это общий бюджет всех его операций, а не отдельный лимит для waitFor и click.
  const stepDeadline = Date.now() + timeout;
  const left = () => {
    const value = remainingMs(stepDeadline);
    if (value <= 0) throw new Error("Сценарий остановлен: timeoutMs шага истёк.");
    return value;
  };

  switch (step.action) {
    case "goto": {
      const response = await loadAndSettle(page, baseUrl + scenarioPath(step.path), {
        timeoutMs: timeout,
        networkIdleMs: Math.min(2_000, timeout),
        settleMs: Math.min(900, timeout),
      });
      input.setDocumentStatus(response?.status() ?? null);
      break;
    }
    case "click": {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: "visible", timeout: left() });
      if (step.force !== true && !(await target.isEnabled())) {
        throw new Error("Элемент виден, но выключен: " + step.selector);
      }
      if (step.touch === true) await target.tap({ timeout: left(), force: step.force === true });
      else await target.click({ timeout: left(), force: step.force === true });
      await waitForNetwork(page, left(), deadline);
      break;
    }
    case "tap": {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: "visible", timeout: left() });
      if (step.force !== true && !(await target.isEnabled())) {
        throw new Error("Элемент виден, но выключен: " + step.selector);
      }
      await target.tap({ timeout: left(), force: step.force === true });
      await waitForNetwork(page, left(), deadline);
      break;
    }
    case "clickAt": {
      const x = Number(step.x);
      const y = Number(step.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Для clickAt нужны координаты x и y");
      if (step.touch === true) await touchTapAt(page, { x, y });
      else await page.mouse.click(x, y);
      await page.waitForTimeout(Math.min(80, left()));
      break;
    }
    case "fill": {
      await page.locator(step.selector).first().fill(step.value, { timeout, force: step.force === true });
      break;
    }
    case "hover": {
      await page.locator(step.selector).first().hover({ timeout, force: step.force === true });
      break;
    }
    case "longPress": {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: "visible", timeout: left() });
      const box = await target.boundingBox({ timeout: left() });
      if (!box) throw new Error("Не удалось найти видимую область для longPress: " + step.selector);
      const holdMs = Math.min(readMs(step.durationMs, 700, 10_000), remainingMs(stepDeadline));
      if (holdMs <= 0) throw new Error("Сценарий остановлен: timeoutMs шага истёк перед longPress.");
      await longPressOnPage(
        page,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        holdMs,
        step.touch === true,
      );
      break;
    }
    case "press": {
      const requestedHold = readMs(step.holdMs, 0, 30_000);
      const hold = Math.min(requestedHold, remainingMs(stepDeadline));
      if (requestedHold > 0 && hold <= 0) throw new Error("Сценарий остановлен: timeoutMs шага истёк перед press.");
      if (step.selector) {
        const target = page.locator(step.selector).first();
        await target.waitFor({ state: "visible", timeout: left() });
        await target.focus({ timeout: left() });
      }
      // Фокус тоже тратит бюджет шага, поэтому удержание пересчитываем после него.
      const actualHold = Math.min(hold, remainingMs(stepDeadline));
      if (requestedHold > 0 && actualHold <= 0) throw new Error("Сценарий остановлен: timeoutMs шага истёк перед удержанием press.");
      if (actualHold > 0) {
        await page.keyboard.down(step.key);
        try {
          await page.waitForTimeout(actualHold);
        } finally {
          await page.keyboard.up(step.key);
        }
      } else {
        await page.keyboard.press(step.key);
      }
      await waitForNetwork(page, left(), deadline);
      break;
    }
    case "expectText": {
      await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout });
      break;
    }
    case "expectUrl": {
      const pattern = new RegExp(step.pattern);
      await poll(async () => pattern.test(page.url()) ? page.url() : false, timeout, "URL /" + step.pattern + "/");
      break;
    }
    case "expectVisible":
      await page.locator(step.selector).first().waitFor({ state: "visible", timeout });
      break;
    case "expectNotVisible":
      await page.locator(step.selector).first().waitFor({ state: "hidden", timeout });
      break;
    case "expectAttribute": {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: "attached", timeout: left() });
      const actual = await poll(async () => {
        const value = await target.getAttribute(step.name);
        if (step.value === undefined) return value !== null ? { value } : false;
        return value === step.value ? { value } : false;
      }, left(), "Атрибут " + step.name + " у " + step.selector);
      result.expectation = { kind: "attribute", actual: actual.value, expected: step.value ?? null };
      break;
    }
    case "expectCount": {
      const expected = Math.max(0, Math.floor(step.count));
      // 0 — законное ожидание, а poll считает success только truthy, поэтому оборачиваем в объект.
      const match = await poll(async () => {
        const count = await page.locator(step.selector).count();
        return count === expected ? { count } : false;
      }, left(), "Количество " + step.selector + " = " + expected);
      result.expectation = { kind: "count", actual: match.count, expected };
      break;
    }
    case "expectValue": {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: "attached", timeout: left() });
      // Пустая строка — тоже допустимое значение поля, не путать с «ещё не совпало».
      const match = await poll(async () => {
        const value = await target.inputValue().catch(() => "");
        return value === step.value ? { value } : false;
      }, left(), "Значение " + step.selector);
      result.expectation = { kind: "value", actual: match.value, expected: step.value };
      break;
    }
    case "waitForSelector": {
      await page.locator(step.selector).first().waitFor({ state: step.state ?? "visible", timeout });
      break;
    }
    case "waitForNetworkIdle":
      await page.waitForLoadState("networkidle", { timeout });
      break;
    case "waitForFunction": {
      const value = await page.waitForFunction(step.expression, step.arg, { timeout });
      result.expectation = { kind: "function", actual: await value.jsonValue().catch(() => null), expected: true };
      break;
    }
    case "wait": {
      const waitMs = Math.min(readWaitMs(step.ms), remainingMs(deadline));
      if (waitMs <= 0) throw new Error("Сценарий остановлен: общий timeoutMs истёк перед паузой.");
      await page.waitForTimeout(waitMs);
      break;
    }
    case "setLocalStorage": {
      await page.evaluate(values => {
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      }, step.values);
      break;
    }
    case "drag": {
      const from = readPoint(step.from);
      const to = readPoint(step.to);
      if (!from || !to) throw new Error("Для drag нужны точки from:{x,y} и to:{x,y}");
      const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
      await dragOnPage(page, { from: clampPoint(from, viewport), to: clampPoint(to, viewport), steps: step.steps, touch: step.touch });
      await page.waitForTimeout(Math.min(150, left()));
      break;
    }
    case "screenshot": {
      const root = await ensureRoot();
      if (!root) throw new Error("Не удалось получить каталог проекта для скриншота: неизвестен владелец проекта");
      const capture = await captureScenarioScreenshot(page, {
        root,
        projectId,
        label: step.name?.trim() || phase + "-step-" + (index + 1),
        fullPage: step.fullPage === true,
        ...(step.selector ? { selector: step.selector } : {}),
        timeout,
        compareBaseline: step.baseline === true,
        updateBaseline: step.updateBaseline === true,
      });
      result.screenshot = capture.screenshot;
      if (capture.baseline) result.baseline = capture.baseline;
      result.layout = await readLayout(page).catch(() => undefined);
      break;
    }
    case "expectScreenshot": {
      const root = await ensureRoot();
      if (!root) throw new Error("Не удалось получить каталог проекта для сравнения скриншота: неизвестен владелец проекта");
      const capture = await captureScenarioScreenshot(page, {
        root,
        projectId,
        label: step.name?.trim() || "expect-" + phase + "-step-" + (index + 1),
        ...(step.selector ? { selector: step.selector } : {}),
        timeout,
        compareBaseline: step.baseline !== false,
        updateBaseline: step.updateBaseline === true,
      });
      result.screenshot = capture.screenshot;
      result.baseline = capture.baseline;
      if (capture.baseline?.created && step.updateBaseline !== true) {
        throw new Error("Baseline создан: " + capture.baseline.path + ". Повторите сценарий — следующий кадр будет сравнён с ним.");
      }
      if (capture.baseline?.changed) {
        throw new Error("Скриншот отличается от baseline: " + capture.baseline.path +
          (capture.baseline.diff ? " (изменено " + capture.baseline.diff.changedPixels + " пикселей, diff: " + capture.baseline.diff.path + ")" : " (сравнение PNG)."));
      }
      break;
    }
    default:
      throw new Error("Unsupported scenario action: " + (step as { action?: string }).action);
  }
  return result;
}

/**
 * Один неудачный шаг должен оставить не только текст ошибки, но и кадр с консолью этого момента.
 * Снимок — служебный файл проекта, поэтому в контекст не попадает base64.
 */
async function captureFailure(input: {
  page: Page;
  projectId: string;
  phase: "setup" | "scenario";
  index: number;
  ensureRoot: () => Promise<string | null>;
  result: ScenarioStepResult;
}) {
  const root = await input.ensureRoot();
  if (!root) return;
  try {
    input.result.screenshot = await saveScreenshot(input.page, {
      root,
      projectId: input.projectId,
      label: "failure-" + input.phase + "-" + (input.index + 1),
      fullPage: false,
      timeout: 5_000,
    });
    input.result.layout = await readLayout(input.page).catch(() => undefined);
  } catch {
    // Падение шага не должно становиться падением снимка.
  }
}

function attachOverlap(detail: string, overlap: Awaited<ReturnType<typeof inspectOverlap>>) {
  const summary = overlapSummary(overlap);
  return summary ? detail + "\n\nПерекрытие: " + summary : detail;
}

async function runOneStep(input: Parameters<typeof runStep>[0] & {
  table: Mutable<{ consoleErrors: ConsoleMessage[]; pageErrors: string[]; failedRequests: Array<{ url: string; error: string }>; httpErrors: Array<{ url: string; status: number }> }>;
}) {
  const before = {
    console: input.table.consoleErrors.length,
    page: input.table.pageErrors.length,
    failed: input.table.failedRequests.length,
    http: input.table.httpErrors.length,
  };
  try {
    const result = await runStep(input);
    // Даём консоли и pageerror дойти до слушателей, иначе ошибка шага приклеится к следующему.
    await input.page.waitForTimeout(40).catch(() => undefined);
    result.diagnostics = diagnosticsSince({ ...input.table, start: before });
    if (!hasDiagnostics(result.diagnostics)) delete result.diagnostics;
    return result;
  } catch (error) {
    const detail = playwrightDetail(error);
    const result: ScenarioStepResult = {
      step: input.index + 1,
      phase: input.phase,
      action: input.step.action,
      ok: false,
      detail,
      callLog: detail,
    };
    if (input.step.action === "click" || input.step.action === "tap") {
      result.overlap = await inspectOverlap(input.page, input.step.selector).catch(() => null) ?? undefined;
    } else if (input.step.action === "clickAt") {
      result.overlap = await inspectOverlap(input.page, undefined, { x: Number(input.step.x), y: Number(input.step.y) }).catch(() => null) ?? undefined;
    }
    if (result.overlap) result.detail = attachOverlap(result.detail ?? "", result.overlap);
    // Снимок делаем до снятия консоли: ошибка, которую вызвало само действие, успевает прийти,
    // пока Chromium снимает кадр. Иначе «консоль на момент падения» теряет последнюю запись.
    await captureFailure({ ...input, result });
    await input.page.waitForTimeout(50).catch(() => undefined);
    result.diagnostics = diagnosticsSince({ ...input.table, start: before });
    if (!hasDiagnostics(result.diagnostics)) delete result.diagnostics;
    return result;
  }
}

function viewportFromInput(value: unknown) {
  const name = readBrowserViewport(value);
  return { name, viewport: BROWSER_VIEWPORTS[name] };
}

function defaultDeadline(input: BrowserScenarioInput) {
  const timeout = readMs(input.timeoutMs, DEFAULT_SCENARIO_TIMEOUT_MS, MAX_SCENARIO_TIMEOUT_MS);
  return Date.now() + timeout;
}

/**
 * Запускает сценарий в Chromium. Каждый шаг получает свой timeoutMs и не может пережить общий
 * дедлайн; при падении сохраняет PNG, консоль и диагностику перекрытия. Сценарий не возвращает
 * base64 в контекст модели.
 */
export async function runBrowserScenario(
  projectId: string,
  input: unknown,
  userId?: string,
  deps: BrowserScenarioDeps = {},
): Promise<Record<string, unknown>> {
  const scenario = readScenarioInput(input);
  const setup = scenario.setup ?? [];
  const steps = scenario.steps ?? [];
  if (!setup.length && !steps.length) return { ok: false, error: "Нужен хотя бы один шаг сценария." };

  const status = await previewStatus(projectId);
  if (!status.running) throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");

    const { name: viewportName, viewport } = viewportFromInput(scenario.viewport);
  const allSteps = [...setup, ...steps];
  const deadline = defaultDeadline(scenario);

  const hasTouch = viewportName === "mobile" || allSteps.some(isTouchStep);
  const launch = deps.launch ?? chromium.launch;
  // Запуск Chromium тоже входит в общий timeoutMs: иначе зависший launch не ограничен ничем.
  const browser: Browser = await launch({
    headless: true,
    executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined,
    timeout: Math.max(1, remainingMs(deadline)),
  });
  const consoleErrors: ConsoleMessage[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ url: string; error: string }> = [];
  const httpErrors: Array<{ url: string; status: number }> = [];
  const results: ScenarioStepResult[] = [];
  const setupResults: ScenarioStepResult[] = [];

  let captureRoot: string | null | undefined;
  const ensureCaptureRoot = async () => {
    if (captureRoot !== undefined) return captureRoot;
    if (!userId) return null;
    captureRoot = (await getSandbox(projectId, userId).catch(() => null))?.root ?? null;
    return captureRoot;
  };

  try {
    const page = await browser.newPage({
      viewport,
      hasTouch,
      isMobile: viewportName === "mobile",
    });
    page.on("console", message => {
      if (message.type() === "error" && consoleErrors.length < 100) {
        consoleErrors.push({ text: message.text().slice(0, 4000), url: message.location()?.url ?? "" });
      }
    });
    page.on("pageerror", error => {
      if (pageErrors.length < 100) pageErrors.push(error.message.slice(0, 4000));
    });
    page.on("response", response => {
      if (response.status() >= 400 && httpErrors.length < 100) {
        httpErrors.push({ url: response.url().slice(0, 4000), status: response.status() });
      }
    });
    page.on("requestfailed", request => {
      if (failedRequests.length < 100) {
        failedRequests.push({ url: request.url().slice(0, 4000), error: request.failure()?.errorText ?? "request failed" });
      }
    });

    if (scenario.storage) {
      await page.context().addInitScript(values => {
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      }, scenario.storage);
    }

    let startResponse: Awaited<ReturnType<typeof loadAndSettle>> | null = null;
    try {
      startResponse = await loadAndSettle(page, `http://${current.host}:${current.port}${scenario.path ?? "/"}`, {
        // Первая загрузка тоже подчиняется общему timeoutMs: сцена с моделями может быть
        // заметно тяжелее обычной страницы, и 20 секунд здесь больше не жёсткий потолок.
        timeoutMs: Math.max(1, remainingMs(deadline)),
        networkIdleMs: 4_000,
        settleMs: 900,
      });
    } catch (error) {
      // Первая загрузка — такой же провал, как шаг: без failedStep и PNG модель снова
      // осталась бы с одной строкой ошибки и не знала, что именно не загрузилось.
      const detail = playwrightDetail(error);
      const failure: ScenarioStepResult = {
        step: 1,
        phase: "setup",
        action: "goto",
        ok: false,
        detail,
        callLog: detail,
      };
      await captureFailure({ page, projectId, phase: "setup", index: 0, ensureRoot: ensureCaptureRoot, result: failure });
      await page.waitForTimeout(50).catch(() => undefined);
      failure.diagnostics = diagnosticsSince({
        consoleErrors,
        pageErrors,
        failedRequests,
        httpErrors,
        start: { console: 0, page: 0, failed: 0, http: 0 },
      });
      if (!hasDiagnostics(failure.diagnostics)) delete failure.diagnostics;
      setupResults.push(failure);
    }
    let documentStatus: number | null = startResponse?.status() ?? null;

    const common = {
      page,
      projectId,
      baseUrl: `http://${current.host}:${current.port}`,
      deadline,
      ensureRoot: ensureCaptureRoot,
      documentStatus: () => documentStatus,
      setDocumentStatus: (value: number | null) => { documentStatus = value; },
      table: { consoleErrors, pageErrors, failedRequests, httpErrors },
    };

    if (setupResults.every(item => item.ok)) {
      for (let index = 0; index < setup.length; index++) {
        // Не бросаем исключение до runOneStep: истёкший общий дедлайн — это тоже неудачный шаг,
        // который обязан оставить failedStep, call log и PNG, а не оборвать сценарий с голой ошибкой.
        const result = await runOneStep({ ...common, step: setup[index], index, phase: "setup" });
        setupResults.push(result);
        if (!result.ok) break;
      }
    }

    if (setupResults.every(item => item.ok)) {
      for (let index = 0; index < steps.length; index++) {
        // См. setup: дедлайн должен попасть в диагностику шага, а не выбросить весь результат.
        const result = await runOneStep({ ...common, step: steps[index], index, phase: "scenario" });
        results.push(result);
        if (!result.ok) break;
      }
    }

    // Если страница уже упала, сохранённый failedStep и PNG важнее ещё одного исключения:
    // отдаём пустую evidence, чтобы агент всё равно получил диагностику шага.
    const rendered = await readPageEvidence(page).catch(() => ({
      title: "",
      text: "",
      textChars: 0,
      visibleElements: 0,
      blank: true,
      styles: {
        declaredStylesheets: 0,
        loadedStylesheets: 0,
        inlineStyles: 0,
        cssRules: 0,
        bodyBackground: "",
        bodyColor: "",
        unstyled: false,
        noStyles: true,
      },
    }));
    const failedSetup = setupResults.find(item => !item.ok);
    const failedStep = results.find(item => !item.ok);
    const stepsPassed = setupResults.length === setup.length && setupResults.every(item => item.ok) &&
      results.length === steps.length && results.every(item => item.ok);
    const judged = classifyRuntimeFailures({ pageErrors, consoleErrors, failedRequests, httpErrors, documentStatus, blank: rendered.blank, styles: rendered.styles });
    const ok = stepsPassed && judged.ok;
    const screenshots = [...setupResults, ...results]
      .filter((item): item is ScenarioStepResult & { screenshot: SavedScreenshot } => Boolean(item.screenshot))
      .map(item => ({ step: item.step, phase: item.phase, ...item.screenshot, ...(item.layout ? { layout: item.layout } : {}), ...(item.baseline ? { baseline: item.baseline } : {}) }));
    const failed = failedSetup ?? failedStep;
    // Если шаг формально прошёл, а страница пустая/сломана, failedStep нет. Всё равно оставляем
    // кадр финального состояния: без него разбор такого провала снова начинается с догадок.
    if (!ok && !failed) {
      const root = await ensureCaptureRoot().catch(() => null);
      if (root) {
        const screenshot = await saveScreenshot(page, {
          root,
          projectId,
          label: "failure-final",
          fullPage: false,
          timeout: 5_000,
        }).catch(() => null);
        if (screenshot) {
          const layout = await readLayout(page).catch(() => undefined);
          screenshots.push({
            step: Math.max(1, setupResults.length + results.length),
            phase: "scenario",
            ...screenshot,
            ...(layout ? { layout } : {}),
          });
        }
      }
    }
    const failedPhase = failed?.phase === "setup" ? "setup-шаг" : "шаг";
    const shortDetail = (failed?.detail ?? "").split("\n").find(line => line.trim()) ?? "шаг не выполнился";
    let finalUrl = "";
    try { finalUrl = page.url(); } catch { finalUrl = ""; }
    return {
      ok,
      // failedStep идёт первым: хвост consoleErrors/network arrays не должен вытеснить из
      // ограниченного вывода инструмента именно тот call log, ради которого он нужен.
      ...(failed ? { failedStep: failed } : {}),
      initialPath: scenario.path ?? "/",
      viewport: viewportName,
      timeoutMs: readMs(scenario.timeoutMs, DEFAULT_SCENARIO_TIMEOUT_MS, MAX_SCENARIO_TIMEOUT_MS),
      steps: results,
      ...(setupResults.length ? { setup: setupResults } : {}),
      screenshots,
      finalUrl,
      documentStatus,
      rendered,
      consoleErrors,
      pageErrors,
      failedRequests,
      httpErrors,
      background: judged.background,
      failures: judged.failures,
      diagnostic: ok
        ? "Сценарий прошёл: шаги выполнились, страница отрисовала содержимое, ошибок страницы, консоли и сети нет." +
          (screenshots.length ? " Снимков: " + screenshots.length + "." : "")
        : (!stepsPassed ? "Сценарий остановлен на " + failedPhase + " " + failed?.step + " (" + failed?.action + "): " + shortDetail + ". Полный call log — в failedStep.detail/failedStep.callLog." : "") +
          (judged.failures.length ? " Поломки: " + judged.failures.slice(0, 3).join("; ") + (judged.failures.length > 3 ? " …" : "") + "." : "") +
          (judged.background.length ? " Фон, который чинить не нужно: " + judged.background.slice(0, 3).join("; ") + "." : ""),
      nextAction: ok
        ? "Browser QA passed."
        : rendered.blank
          ? "Страница пустая: приложение ничего не отрисовало. Проверьте точку входа, стартовый маршрут и состояние загрузки до ответа авторизации."
          : !stepsPassed
            ? "Исправьте то, на чём остановился шаг. Если кнопку перекрывает декоративный слой, смотрите failedStep.overlap; call log и PNG этого шага — рядом."
            : "Исправьте перечисленное в failures, затем запустите сценарий снова.",
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export { stepTimeoutMs };
export type { BrowserScenarioInput } from "./types.js";
