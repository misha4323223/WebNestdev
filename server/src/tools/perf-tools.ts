import { chromium } from "playwright";
import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";
import { withBrowserSlot } from "./browser-limiter.js";
import { BROWSER_VIEWPORTS, readBrowserViewport } from "./browser-viewport.js";

/**
 * `browser.perf` — числа вместо «должно быть быстро».
 *
 * Сборка и layout говорят, что приложение работает, но не сколько кадров оно выдаёт и не какие
 * задачи блокируют главный поток. Для игры на requestAnimationFrame это и есть предмет проверки:
 * 22 fps и 60 fps выглядят одинаково в DOM. Инструмент считает кадры за окно времени, собирает
 * long tasks, LCP и CLS; в headless-браузере это относительные числа, а не обещание fps на
 * телефоне пользователя, поэтому ответ прямо называет ограничение.
 */

const LOAD_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_MS = 4_000;
const SETTLE_MS = 700;
const DEFAULT_DURATION_MS = 2_000;
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 10_000;

const INIT_SCRIPT = `(() => {
  const state = { longTasks: [], lcp: 0, cls: 0 };
  Object.defineProperty(window, "__wndPerf", { value: state, configurable: true });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch (error) {}
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) state.lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (error) {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) state.cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch (error) {}
})();`;

type PerfState = { longTasks: Array<{ start: number; duration: number }>; lcp: number; cls: number };
type FrameCount = { frames: number; elapsed: number };

async function measure(projectId: string, input: unknown) {
  const value = (input && typeof input === "object" ? input : {}) as {
    path?: unknown;
    viewport?: unknown;
    durationMs?: unknown;
  };
  const requestedPath = typeof value.path === "string" && value.path.trim() ? value.path.trim() : "/";
  const path = requestedPath.startsWith("/") ? requestedPath : "/" + requestedPath;
  const viewportName = readBrowserViewport(value.viewport);
  const durationMs = typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
    ? Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(value.durationMs)))
    : DEFAULT_DURATION_MS;

  const status = await previewStatus(projectId);
  if (!status.running) throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");

  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ viewport: BROWSER_VIEWPORTS[viewportName] });
    try {
      const page = await context.newPage();
      await page.addInitScript({ content: INIT_SCRIPT });
      const response = await page.goto(`http://${current.host}:${current.port}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: LOAD_TIMEOUT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS }).catch(() => undefined);
      await page.waitForTimeout(SETTLE_MS);

      const frames = await page.evaluate(
        `new Promise((resolve) => {
          let count = 0;
          const started = performance.now();
          const tick = () => {
            count += 1;
            if (performance.now() - started < ${durationMs}) requestAnimationFrame(tick);
            else resolve({ frames: count, elapsed: performance.now() - started });
          };
          requestAnimationFrame(tick);
        })`,
      ) as FrameCount;
      const state = await page.evaluate("window.__wndPerf || { longTasks: [], lcp: 0, cls: 0 }") as PerfState;
      const extra = await page.evaluate(
        `(() => {
          const nav = performance.getEntriesByType("navigation")[0];
          const resources = performance.getEntriesByType("resource");
          return {
            domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
            loadMs: nav ? nav.loadEventEnd : null,
            resourceCount: resources.length,
            transferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0),
          };
        })()`,
      ) as { domContentLoadedMs: number | null; loadMs: number | null; resourceCount: number; transferBytes: number };

      const fps = frames.elapsed > 0 ? Math.round((frames.frames / frames.elapsed) * 1000 * 10) / 10 : 0;
      const longTasks = state.longTasks.slice(0, 20);
      const totalLongTaskMs = Math.round(state.longTasks.reduce((sum, item) => sum + item.duration, 0));
      const maxLongTaskMs = Math.round(state.longTasks.reduce((max, item) => Math.max(max, item.duration), 0));
      return {
        ok: true,
        path,
        viewport: viewportName,
        durationMs,
        status: response?.status() ?? null,
        fps,
        frames: frames.frames,
        measuredMs: Math.round(frames.elapsed),
        longTasks: {
          count: state.longTasks.length,
          totalMs: totalLongTaskMs,
          maxMs: maxLongTaskMs,
          samples: longTasks,
        },
        lcpMs: Math.round(state.lcp * 10) / 10,
        cls: Math.round(state.cls * 1000) / 1000,
        navigation: extra,
        note: "Это замер в headless Chromium внутри контейнера, а не на устройстве пользователя: сравнивайте числа до и после правки, а не с абсолютным 60 fps.",
        diagnostic: "FPS " + fps + " за " + Math.round(frames.elapsed) + " мс, long tasks " + state.longTasks.length +
          (maxLongTaskMs ? " (максимум " + maxLongTaskMs + " мс)" : "") +
          ", LCP " + Math.round(state.lcp) + " мс, CLS " + Math.round(state.cls * 1000) / 1000 + ".",
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close();
  }
}

registerTool({
  name: "browser.perf",
  description:
    "Measure runtime performance of a Preview page in headless Chromium. Input: {path?, viewport?:'desktop'|'tablet'|'mobile', durationMs? (500–10000, default 2000)}. Returns FPS counted from requestAnimationFrame, long tasks (count/total/max), LCP, CLS, DOMContentLoaded/load and resource transfer size. Use it for games and animations before/after a change; these are relative headless numbers, not a promise of the user's device FPS.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Маршрут предпросмотра, по умолчанию /" },
      viewport: { type: "string", enum: ["desktop", "tablet", "mobile"], description: "Размер окна; по умолчанию desktop" },
      durationMs: { type: "number", description: "Сколько миллисекунд считать кадры: 500–10000, по умолчанию 2000" },
    },
  },
  execute: async (input, context) => withBrowserSlot(() => measure(context.projectId, input)),
});
