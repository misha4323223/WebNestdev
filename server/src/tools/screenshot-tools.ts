import { chromium, type Browser } from "playwright";
import { getSandbox } from "../sandbox/sandbox-service.js";
import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";
import { withBrowserSlot } from "./browser-limiter.js";
import { layoutSummary, readLayout, saveScreenshot, type LayoutAudit, type SavedScreenshot } from "./screenshot-file.js";

/**
 * Снимок страницы — вторая половина проверки вёрстки. browser.runtime отвечает, что страница
 * отрисовалась и стили применились, но не показывает, уехал ли грид и не прижалась ли картинка к
 * меню: без картинки такие дефекты находит только пользователь. Инструмент делает PNG и, что важнее
 * для модели, текстовую сводку вёрстки: вылезшие за экран элементы, горизонтальную прокрутку, битые
 * картинки, обрезанный текст и слишком мелкие цели на телефоне. Картинку открывает человек или
 * тот, кто умеет смотреть изображения; числа читает модель.
 */

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
} as const;

export type ScreenshotViewport = keyof typeof VIEWPORTS;

const SETTLE_MS = 700;
const NETWORK_IDLE_MS = 4_000;
const LOAD_TIMEOUT_MS = 15_000;

function readViewport(input: unknown): ScreenshotViewport {
  const value = (input as { viewport?: unknown } | null)?.viewport;
  return value === "mobile" || value === "tablet" ? value : "desktop";
}

function readPath(input: unknown) {
  const value = (input as { path?: unknown } | null)?.path;
  const requested = typeof value === "string" && value.trim() ? value.trim() : "/";
  return requested.startsWith("/") ? requested : "/" + requested;
}

async function openPreview(projectId: string) {
  const status = await previewStatus(projectId);
  if (!status.running) throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");
  return current;
}

export type ScreenshotResult = {
  ok: boolean;
  viewport: ScreenshotViewport;
  url: string;
  path: string;
  bytes: number;
  layout: LayoutAudit;
  screenshot: SavedScreenshot;
  diagnostic: string;
  nextAction: string;
};

export async function captureScreenshot(input: {
  projectId: string;
  userId: string;
  path: string;
  viewport: ScreenshotViewport;
  fullPage: boolean;
}): Promise<ScreenshotResult> {
  const current = await openPreview(input.projectId);
  const sandbox = await getSandbox(input.projectId, input.userId);
  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined,
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS[input.viewport] });
    try {
      const page = await context.newPage();
      await page.goto(`http://${current.host}:${current.port}${input.path}`, { waitUntil: "domcontentloaded", timeout: LOAD_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS }).catch(() => undefined);
      await page.waitForTimeout(SETTLE_MS);
      const layout = await readLayout(page);
      const screenshot = await saveScreenshot(page, {
        root: sandbox.root,
        projectId: input.projectId,
        label: input.viewport + (input.fullPage ? "-full" : ""),
        fullPage: input.fullPage,
      });
      const problems = layout.findings.length > 0;
      return {
        ok: true,
        viewport: input.viewport,
        url: input.path,
        path: screenshot.path,
        bytes: screenshot.bytes,
        layout,
        screenshot,
        diagnostic: "Снимок " + input.viewport + " сохранён (" + Math.round(screenshot.bytes / 1024) + " КБ). " + layoutSummary(layout),
        nextAction: problems
          ? "Исправьте названные элементы (селектор и причина в layout.findings), затем снимите экран снова: дефект считается закрытым, когда findings пуст."
          : "Вёрстка в этом размере чистая. Для лендинга имеет смысл проверить второй размер — mobile или tablet.",
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close();
  }
}

registerTool({
  name: "browser.screenshot",
  description:
    "Capture a PNG of the running Preview and audit the layout in the same pass. Input: {path?:string, viewport?:'desktop'|'tablet'|'mobile', fullPage?:boolean}. The PNG is saved inside the project (`.webnestdev/screenshots/…`, excluded from git) and returned as `path` + `url`, so a person can open it. The model gets `layout`: horizontal overflow of the page, elements beyond the viewport (with CSS selectors), broken images, clipped text and too-small tap targets on mobile. Use it after project.verify or browser.runtime to see whether the grid, hero image or mobile layout actually looks right instead of trusting console output.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Маршрут предпросмотра, например / или /about; по умолчанию /" },
      viewport: { type: "string", enum: ["desktop", "tablet", "mobile"], description: "Размер окна: desktop 1440×900, tablet 820×1180, mobile 390×844; по умолчанию desktop" },
      fullPage: { type: "boolean", description: "Снимать страницу целиком, а не первый экран; полезно для длинного лендинга" },
    },
  },
  execute: async (input, context) =>
    withBrowserSlot(() =>
      captureScreenshot({
        projectId: context.projectId,
        userId: context.userId ?? "",
        path: readPath(input),
        viewport: readViewport(input),
        fullPage: Boolean((input as { fullPage?: unknown } | null)?.fullPage),
      }),
    ),
});
