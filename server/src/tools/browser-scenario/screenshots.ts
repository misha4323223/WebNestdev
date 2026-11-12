import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { SCREENSHOT_DIR, saveScreenshot, type SavedScreenshot } from "../screenshot-file.js";
import type { BaselineResult } from "./types.js";

export type BaselineCapture = {
  screenshot: SavedScreenshot;
  baseline?: BaselineResult;
  buffer: Buffer;
};

function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "baseline";
}

function baselinePath(root: string, label: string) {
  return path.join(root, SCREENSHOT_DIR, "baseline-" + safeName(label) + ".png");
}

function digest(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Снимок шага и необязательное сравнение с baseline. Сравнение идёт по содержимому PNG: это
 * объективный ответ «кадр изменился или нет» без базового64 в контексте модели. Если baseline
 * отсутствует, он создаётся, а шаг сообщает created — следующий прогон уже сравнивает.
 */
export async function captureScenarioScreenshot(
  page: Page,
  input: {
    root: string;
    projectId: string;
    label: string;
    fullPage?: boolean;
    selector?: string;
    timeout?: number;
    compareBaseline?: boolean;
    updateBaseline?: boolean;
  },
): Promise<BaselineCapture> {
  const screenshot = await saveScreenshot(page, {
    root: input.root,
    projectId: input.projectId,
    label: input.label,
    ...(input.fullPage !== undefined ? { fullPage: input.fullPage } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.timeout ? { timeout: input.timeout } : {}),
  });
  const current = await readFile(path.join(input.root, screenshot.path));
  if (!input.compareBaseline && !input.updateBaseline) {
    return { screenshot, buffer: current };
  }

  const file = baselinePath(input.root, input.label);
  let previous: Buffer | null = null;
  try {
    previous = await readFile(file);
  } catch {
    previous = null;
  }
  let changed = input.updateBaseline === true ? false : previous ? !previous.equals(current) : false;
  let diff: BaselineResult["diff"];
  if (previous && input.updateBaseline !== true && changed) {
    // Сравнение PNG по байтам отвечает «изменилось ли», но не «насколько». Рисуем diff в самом
    // Chromium: canvas уже есть, зависимость для декодирования PNG не нужна.
    try {
      // Считаем в отдельной пустой странице: строгий CSP приложения не должен запрещать data:-URL
      // baseline-картинок. Никаких локальных функций внутри evaluate: сборка через tsx подмешивает
      // к ним __name, которого нет в контексте страницы. Поэтому картинки читаются линейным кодом.
      const helper = await page.context().newPage();
      const pixelDiff = await (async () => {
        try {
          return await helper.evaluate(async ({ before, after }) => {
        const left = new Image();
        left.src = before;
        await left.decode();
        const right = new Image();
        right.src = after;
        await right.decode();
        if (left.naturalWidth !== right.naturalWidth || left.naturalHeight !== right.naturalHeight) {
          return { changedPixels: -1, totalPixels: 0, ratio: 1, width: right.naturalWidth, height: right.naturalHeight, diff: "" };
        }
        const width = right.naturalWidth;
        const height = right.naturalHeight;
        const beforeCanvas = document.createElement("canvas");
        beforeCanvas.width = width;
        beforeCanvas.height = height;
        const beforeContext = beforeCanvas.getContext("2d", { willReadFrequently: true });
        if (!beforeContext) throw new Error("canvas 2d недоступен");
        beforeContext.drawImage(left, 0, 0);
        const beforePixels = beforeContext.getImageData(0, 0, width, height).data;
        const afterCanvas = document.createElement("canvas");
        afterCanvas.width = width;
        afterCanvas.height = height;
        const afterContext = afterCanvas.getContext("2d", { willReadFrequently: true });
        if (!afterContext) throw new Error("canvas 2d недоступен");
        afterContext.drawImage(right, 0, 0);
        const afterPixels = afterContext.getImageData(0, 0, width, height).data;
        const output = document.createElement("canvas");
        output.width = width;
        output.height = height;
        const context = output.getContext("2d");
        if (!context) throw new Error("canvas 2d недоступен");
        const image = context.createImageData(width, height);
        let changedPixels = 0;
        for (let index = 0; index < beforePixels.length; index += 4) {
          const different = beforePixels[index] !== afterPixels[index] ||
            beforePixels[index + 1] !== afterPixels[index + 1] ||
            beforePixels[index + 2] !== afterPixels[index + 2];
          if (different) {
            changedPixels++;
            image.data[index] = 255;
            image.data[index + 1] = 40;
            image.data[index + 2] = 40;
            image.data[index + 3] = 255;
          } else {
            // Совпавшие пиксели оставляем прозрачными, красным видно только изменение.
            image.data[index + 3] = 0;
          }
        }
        context.putImageData(image, 0, 0);
        return { changedPixels, totalPixels: width * height, ratio: changedPixels / (width * height), width, height, diff: output.toDataURL("image/png") };
          }, { before: "data:image/png;base64," + previous.toString("base64"), after: "data:image/png;base64," + current.toString("base64") });
        } finally {
          await helper.close().catch(() => undefined);
        }
      })();
      if (pixelDiff.changedPixels >= 0) {
        changed = pixelDiff.changedPixels > 0;
        diff = {
          path: path.relative(input.root, path.join(input.root, SCREENSHOT_DIR, "diff-" + safeName(input.label) + ".png")).split(path.sep).join("/"),
          changedPixels: pixelDiff.changedPixels,
          totalPixels: pixelDiff.totalPixels,
          ratio: pixelDiff.ratio,
          width: pixelDiff.width,
          height: pixelDiff.height,
        };
        if (pixelDiff.diff) {
          const payload = pixelDiff.diff.split(",")[1] ?? "";
          await writeFile(path.join(input.root, diff.path), Buffer.from(payload, "base64"));
        }
      }
    } catch {
      // Diff — дополнительная улика: если canvas/PNG не сложился, остаётся честное changed по SHA.
    }
  }
  const created = previous === null || input.updateBaseline === true;
  if (created) await writeFile(file, current);
  return {
    screenshot,
    buffer: current,
    baseline: {
      path: path.relative(input.root, file).split(path.sep).join("/"),
      bytes: current.length,
      changed,
      created,
      hash: digest(current),
      ...(diff ? { diff } : {}),
    },
  };
}
