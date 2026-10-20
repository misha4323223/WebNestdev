import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { layoutSummary, readLayout, saveScreenshot } from "./screenshot-file.js";

/**
 * Снимок нужен ровно за тем, чего нет в консоли: уехал грид, картинка не загрузилась, текст
 * обрезан. Эти дефекты не роняют страницу, поэтому проверяются здесь на реальном Chromium —
 * и как файл PNG, и как текстовая сводка, которую читает модель.
 */
const BROKEN_LAYOUT = `<!doctype html><html><head><meta charset="utf-8"><title>Портфолио</title>
<style>
  body{margin:0;font-family:sans-serif}
  .wide{width:2200px;height:40px;background:#222}
  .clip{width:120px;overflow:hidden;white-space:nowrap}
</style></head><body>
<div class="wide">уехавшая вбок полоса</div>
<p class="clip">Очень длинный заголовок, который не влезает в свою колонку целиком</p>
<img src="/missing.png" alt="фото работы">
</body></html>`;

async function startPage() {
  const server = createServer((request, response) => {
    if ((request.url ?? "").startsWith("/missing.png")) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(BROKEN_LAYOUT);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function chromiumAvailable() {
  try {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

test("снимок ловит уехавшую вёрстку и битую картинку, а PNG остаётся файлом проекта", async t => {
  if (!(await chromiumAvailable())) return t.skip("Chromium недоступен в этой среде");
  const app = await startPage();
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-shot-"));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:" + app.port + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);

    const layout = await readLayout(page);
    assert.ok(layout.page.horizontalOverflow > 100, "страница шире экрана — это факт, а не мнение: " + layout.page.horizontalOverflow);
    assert.ok(layout.findings.some(item => item.kind === "overflow"), layout.findings.map(item => item.kind).join(", "));
    assert.ok(layout.findings.some(item => item.kind === "brokenImage"), "битая картинка названа по селектору");
    assert.ok(layout.findings.some(item => item.kind === "clippedText"), "обрезанный текст виден без зрения");
    assert.match(layoutSummary(layout), /Замечания по вёрстке/);

    const shot = await saveScreenshot(page, { root, projectId: "p-shot", label: "mobile", fullPage: false });
    assert.match(shot.path, /^\.webnestdev\/screenshots\/mobile-[a-z0-9]+\.png$/, shot.path);
    assert.match(shot.url, /^\/api\/projects\/p-shot\/screenshot\?path=/, shot.url);
    const bytes = await readFile(path.join(root, shot.path));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "в файле лежит настоящий PNG");
    assert.equal(bytes.length, shot.bytes);

    // Чистая страница не выдумывает замечаний: иначе агент «чинит» то, что не сломано.
    await page.setContent("<!doctype html><html><body><h1 style='margin:16px'>Готово</h1></body></html>");
    const clean = await readLayout(page);
    assert.equal(clean.page.horizontalOverflow, 0);
    assert.equal(clean.findings.length, 0, clean.findings.map(item => item.selector + ": " + item.detail).join("; "));
    assert.match(layoutSummary(clean), /без замечаний/);
  } finally {
    await browser.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
