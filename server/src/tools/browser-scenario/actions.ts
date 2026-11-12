import type { Page } from "playwright";
import type { ScenarioPoint } from "../../qa/scenario-planner.js";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  MAX_DRAG_STEPS,
  MAX_STEP_TIMEOUT_MS,
  MAX_WAIT_MS,
  type OverlapInfo,
} from "./types.js";

/** Положительное число миллисекунд в разумных границах; мусор не должен превращаться в 0. */
export function readMs(value: unknown, fallback: number, max = MAX_STEP_TIMEOUT_MS): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(max, number));
}

/** Сколько осталось до общего дедлайна сценария. */
export function remainingMs(deadline: number, now = Date.now()) {
  return Math.max(0, deadline - now);
}

/**
 * Шаг не может ждать дольше своего timeoutMs и не может пережить общий дедлайн сценария.
 * Иначе один медленный шаг снова «съедает» весь прогон, хотя агент задал общий лимит.
 */
export function stepTimeoutMs(step: { timeoutMs?: unknown } | object, deadline: number, now = Date.now()) {
  const requested = (step as { timeoutMs?: unknown }).timeoutMs;
  const left = remainingMs(deadline, now);
  if (left <= 0) throw new Error("Сценарий остановлен: общий timeoutMs истёк.");
  return Math.max(1, Math.min(readMs(requested, DEFAULT_STEP_TIMEOUT_MS), left));
}

export function readWaitMs(value: unknown) {
  return readMs(value, 1_000, MAX_WAIT_MS);
}

/**
 * Playwright уже содержит полный call log в error.message. Нам не нужен весь stack, но нельзя
 * оставлять только первую строку: именно хвост объясняет, на какой стадии actionability застрял
 * клик. Храним последние 40 строк целиком.
 */
export function playwrightDetail(error: unknown, maxLines = 40) {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw.replace(/\r/g, "").split("\n").filter((line, index, all) => !(index === all.length - 1 && line === ""));
  if (lines.length <= maxLines) return lines.join("\n");
  return "[первые " + (lines.length - maxLines) + " строк опущены]\n" + lines.slice(-maxLines).join("\n");
}

export function readPoint(value: unknown): ScenarioPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as { x?: unknown; y?: unknown };
  const x = typeof point.x === "number" && Number.isFinite(point.x) ? point.x : NaN;
  const y = typeof point.y === "number" && Number.isFinite(point.y) ? point.y : NaN;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function clampPoint(point: ScenarioPoint, viewport: { width: number; height: number }): ScenarioPoint {
  return {
    x: Math.max(0, Math.min(viewport.width, point.x)),
    y: Math.max(0, Math.min(viewport.height, point.y)),
  };
}

/** Ждёт предикат и возвращает его значение; timeout — ошибка шага, а не молчаливый пропуск. */
export async function poll<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const stopAt = Date.now() + timeoutMs;
  let last: T | undefined | false;
  while (Date.now() <= stopAt) {
    last = await check();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label + " не выполнилось за " + timeoutMs + " мс");
}

/**
 * Кто перекрывает цель. Это главный вопрос при таймауте клика: элемент найден и виден, но
 * `elementFromPoint` возвращает декоративный слой, canvas или прозрачную маску. Возвращаем стек
 * сверху вниз, z-index и pointer-events — по этим данным видно, что чинить.
 */
export async function inspectOverlap(page: Page, selector?: string, point?: ScenarioPoint): Promise<OverlapInfo | null> {
  try {
    // Диагностика не имеет права ждать элемент дольше самого шага: иначе после таймаута клика
    // ещё 30 секунд уйдут на поиск рамки отсутствующего элемента.
    const box = selector
      ? await page.locator(selector).first().boundingBox({ timeout: 1_000 }).catch(() => null)
      : null;
    const center = point ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null);
    if (!center) return null;
    // Никаких локальных функций внутри evaluate: tsx подмешивает к ним __name, которого нет
    // в контексте страницы. Описание элементов собираем одним циклом.
    const raw = await page.evaluate(({ selector: targetSelector, x, y }) => {
      let target: Element | null = null;
      if (targetSelector) {
        try { target = document.querySelector(targetSelector); } catch { target = null; }
      }
      const top = document.elementFromPoint(x, y);
      const stack = document.elementsFromPoint(x, y).slice(0, 6);
      const descriptions: Array<{
        selector: string;
        tag: string;
        id: string;
        classes: string;
        zIndex: string;
        pointerEvents: string;
        rect: { x: number; y: number; width: number; height: number };
        text: string;
      } | null> = [];
      const stackDescriptions: Array<{ tag: string; id: string; classes: string; zIndex: string; pointerEvents: string }> = [];
      const elements = [target, top, ...stack];
      for (let position = 0; position < elements.length; position++) {
        const element = elements[position];
        if (!element) {
          descriptions.push(null);
          continue;
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const rawClass = typeof element.className === "string" ? element.className : "";
        const normalizedClass = rawClass.replace(/\s+/g, " ").trim();
        const item = {
          selector: element === target && targetSelector ? targetSelector : "",
          tag: element.tagName.toLowerCase(),
          id: element.id,
          classes: normalizedClass ? normalizedClass.split(" ").slice(0, 3).join(" ") : "",
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        };
        descriptions.push(item);
        if (position >= 2) stackDescriptions.push({ tag: item.tag, id: item.id, classes: item.classes, zIndex: item.zIndex, pointerEvents: item.pointerEvents });
      }
      return {
        target: descriptions[0],
        top: descriptions[1],
        stack: stackDescriptions,
        sameElement: Boolean(top && target ? top === target || target.contains(top) : top === target),
      };
    }, { selector: selector ?? "", x: center.x, y: center.y });
    return {
      point: { x: Math.round(center.x), y: Math.round(center.y) },
      ...(raw.target ? { target: raw.target } : {}),
      ...(raw.top ? { top: raw.top } : {}),
      stack: raw.stack,
      sameElement: raw.sameElement,
    };
  } catch {
    return null;
  }
}

/** Короткая строка для detail: не дублировать весь JSON в сообщении об ошибке. */
export function overlapSummary(info: OverlapInfo | null) {
  if (!info) return "";
  const top = info.top;
  const target = info.target;
  if (!top) return "elementFromPoint(" + info.point.x + "," + info.point.y + ") не нашёл элемента";
  const topName = top.tag + (top.id ? "#" + top.id : "") + (top.classes ? "." + top.classes.replace(/\s+/g, ".") : "");
  const targetName = target ? target.tag + (target.id ? "#" + target.id : "") + (target.classes ? "." + target.classes.replace(/\s+/g, ".") : "") : "координата";
  return "центр " + info.point.x + "," + info.point.y + ": цель " + targetName +
    " (" + (target?.rect.width ?? 0) + "×" + (target?.rect.height ?? 0) +
    ", z-index " + (target?.zIndex ?? "?") + ", pointer-events " + (target?.pointerEvents ?? "?") + "), сверху " + topName +
    " (z-index " + top.zIndex + ", pointer-events " + top.pointerEvents + ")" +
    (info.sameElement ? "; это сама цель" : "; цель перекрыта");
}

/** Touch-клик в координатах: page.mouse.click не создаёт touchstart/pointerdown. */
export async function touchTapAt(page: Page, point: ScenarioPoint) {
  const client = await page.context().newCDPSession(page);
  try {
    const touchPoints = [{ x: point.x, y: point.y }];
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/**
 * Pointer-перетаскивание. Мышь даёт pointerdown → pointermove → pointerup, которых ждут игры на
 * указателях; touch отправляет те же события через CDP, иначе мобильный свайп не проверить.
 */
export async function dragOnPage(
  page: Page,
  input: { from: ScenarioPoint; to: ScenarioPoint; steps?: number; touch?: boolean },
) {
  const count = Math.max(1, Math.min(MAX_DRAG_STEPS, Math.floor(Number(input.steps) || 8)));
  if (input.touch) {
    const client = await page.context().newCDPSession(page);
    try {
      const point = (value: ScenarioPoint) => [{ x: value.x, y: value.y }];
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(input.from) });
      for (let index = 1; index <= count; index++) {
        const ratio = index / count;
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: point({
            x: input.from.x + (input.to.x - input.from.x) * ratio,
            y: input.from.y + (input.to.y - input.from.y) * ratio,
          }),
        });
        await page.waitForTimeout(16);
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await client.detach().catch(() => undefined);
    }
    return;
  }
  await page.mouse.move(input.from.x, input.from.y);
  await page.mouse.down();
  try {
    await page.mouse.move(input.to.x, input.to.y, { steps: count });
  } finally {
    await page.mouse.up();
  }
}

/** Долгое нажатие: удержание кнопки удара и мобильный long-press. */
export async function longPressOnPage(
  page: Page,
  point: ScenarioPoint,
  durationMs: number,
  touch = false,
) {
  if (touch) {
    const client = await page.context().newCDPSession(page);
    try {
      const touchPoints = [{ x: point.x, y: point.y }];
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
      await page.waitForTimeout(durationMs);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await client.detach().catch(() => undefined);
    }
    return;
  }
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    await page.waitForTimeout(durationMs);
  } finally {
    await page.mouse.up();
  }
}
