import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { getTool } from "../tool-registry.js";
import { setPreview } from "../preview/preview-store.js";
import { classifyRuntimeFailures } from "./browser-tools.js";

/**
 * The situation the agent kept losing whole runs on: the app answers, the page is white, and the
 * only errors are 401s from the app's own session endpoint. Before, the scenario failed on those
 * 401s and told the model nothing about the page itself, so the model could only guess why the
 * screen was blank. These tests run real Chromium against a real server and check both halves of
 * the fix: what the tool reports, and what it now counts as a failure.
 */
const BLANK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>
<div id="root"></div>
<script>
  // Страница без авторизации: экран остаётся пустым, а запросы сессии отвечают 401. Браузер
  // записывает этот 401 ещё и в консоль — проверка обязана считать его фоном, а не ошибкой.
  fetch("/api/account/settings").catch(() => {});
</script>
</body></html>`;

const RENDERED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>
<div id="root"><h1>Добро пожаловать</h1><button>Создать проект</button></div>
<script>
  fetch("/api/account/settings").catch(() => {});
</script>
</body></html>`;

const NOT_FOUND_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>404</title></head><body><p>Страница не найдена</p></body></html>`;

async function startApp() {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/api/")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    if (url === "/missing") {
      response.writeHead(404, { "content-type": "text/html" });
      response.end(NOT_FOUND_PAGE);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(url === "/rendered" ? RENDERED_PAGE : BLANK_PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** Chromium is not always installed (CI without a browser); that is a skip, never a silent pass. */
async function chromiumAvailable() {
  try {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

type ScenarioResult = {
  ok: boolean;
  rendered?: { text: string; textChars: number; visibleElements: number; blank: boolean };
  failures?: string[];
  background?: string[];
  diagnostic?: string;
  nextAction?: string;
  documentStatus?: number | null;
};

test("фоновая 401 и отменённые запросы — не поломка, пустой экран и 5xx — поломка", () => {
  const background = classifyRuntimeFailures({
    pageErrors: [],
    consoleErrors: [{ text: "Failed to load resource: the server responded with a status of 401 (Unauthorized)", url: "http://app/api/account/settings" }],
    failedRequests: [{ url: "http://app/api/slow", error: "net::ERR_ABORTED" }],
    httpErrors: [{ url: "http://app/api/account/settings", status: 401 }, { url: "http://app/favicon.ico", status: 404 }],
    documentStatus: 200,
    blank: false,
  });
  assert.equal(background.ok, true, "страница без авторизации проходит проверку");
  assert.equal(background.failures.length, 0);
  assert.equal(background.background.length, 4, "фон перечислен отдельно: " + background.background.join(", "));

  const noisy = classifyRuntimeFailures({
    pageErrors: [],
    consoleErrors: [{ text: "TypeError: root is undefined" }],
    failedRequests: [],
    httpErrors: [{ url: "http://app/api/x", status: 503 }],
    documentStatus: 200,
    blank: false,
  });
  assert.equal(noisy.ok, false, "настоящие ошибки консоли и 5xx остаются поломками");

  const blank = classifyRuntimeFailures({ pageErrors: [], consoleErrors: [], failedRequests: [], httpErrors: [], documentStatus: 200, blank: true });
  assert.equal(blank.ok, false);
  assert.match(blank.failures[0], /пустая/);

  const server = classifyRuntimeFailures({
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [{ url: "http://app/api/x", error: "net::ERR_CONNECTION_REFUSED" }],
    httpErrors: [{ url: "http://app/api/x", status: 500 }],
    documentStatus: 200,
    blank: false,
  });
  assert.equal(server.ok, false);
  assert.equal(server.failures.length, 2);

  const missing = classifyRuntimeFailures({ pageErrors: [], consoleErrors: [], failedRequests: [], httpErrors: [], documentStatus: 404, blank: false });
  assert.equal(missing.ok, false, "несуществующий маршрут остаётся поломкой");
  assert.match(missing.failures[0], /HTTP 404/);
});

test("сценарий в реальном Chromium: пустой экран с фоновой 401 объясняется, а не переспрашивается", async t => {
  if (!(await chromiumAvailable())) return t.skip("Chromium недоступен в этой среде");
  const app = await startApp();
  try {
    setPreview({ mode: "static", containerId: "", host: "127.0.0.1", port: app.port, projectId: "p-blank", startedAt: Date.now(), lastUsedAt: Date.now() });
    const scenario = getTool("browser.scenario");
    assert.ok(scenario?.execute);
    const result = (await scenario.execute({ path: "/", steps: [{ action: "goto", path: "/" }, { action: "expectVisible", selector: "body" }] }, { projectId: "p-blank", runId: "r", userId: "u" })) as ScenarioResult;

    assert.equal(result.ok, false, "белый экран не считается выполнением задачи");
    assert.equal(result.rendered?.blank, true);
    assert.equal(result.rendered?.textChars, 0);
    assert.match(result.diagnostic ?? "", /пустая|ничего не отрисовало/);
    assert.match(result.diagnostic ?? "", /401/, "фон назван фоном, а не причиной");
    assert.match(result.nextAction ?? "", /точку входа|монтирование|#root/);
    assert.ok((result.background ?? []).some(item => item.includes("401")));
    assert.ok(!(result.failures ?? []).some(item => item.includes("401")), "фоновая 401 не попадает в поломки");
  } finally {
    await app.close();
  }
});

test("сценарий в реальном Chromium: рабочая страница проходит, а её текст виден модели", async t => {
  if (!(await chromiumAvailable())) return t.skip("Chromium недоступен в этой среде");
  const app = await startApp();
  try {
    setPreview({ mode: "static", containerId: "", host: "127.0.0.1", port: app.port, projectId: "p-rendered", startedAt: Date.now(), lastUsedAt: Date.now() });
    const scenario = getTool("browser.scenario");
    assert.ok(scenario?.execute);
    const result = (await scenario.execute(
      { path: "/rendered", steps: [{ action: "goto", path: "/rendered" }, { action: "expectText", text: "Добро пожаловать" }, { action: "expectVisible", selector: "button" }] },
      { projectId: "p-rendered", runId: "r", userId: "u" },
    )) as ScenarioResult;

    assert.equal(result.ok, true, "работающая страница проходит, несмотря на фоновую 401: " + (result.diagnostic ?? ""));
    assert.equal(result.rendered?.blank, false);
    assert.match(result.rendered?.text ?? "", /Добро пожаловать/, "модель читает, что на странице");
    assert.ok((result.rendered?.visibleElements ?? 0) > 0);
    assert.ok(!JSON.stringify(result).includes("screenshotBase64"), "нечитаемый скриншот больше не занимает контекст");
  } finally {
    await app.close();
  }
});

test("сценарий в реальном Chromium: несуществующий маршрут остаётся провалом", async t => {
  if (!(await chromiumAvailable())) return t.skip("Chromium недоступен в этой среде");
  const app = await startApp();
  try {
    setPreview({ mode: "static", containerId: "", host: "127.0.0.1", port: app.port, projectId: "p-missing", startedAt: Date.now(), lastUsedAt: Date.now() });
    const scenario = getTool("browser.scenario");
    assert.ok(scenario?.execute);
    const result = (await scenario.execute({ path: "/missing", steps: [{ action: "goto", path: "/missing" }, { action: "expectText", text: "Не найдено" }] }, { projectId: "p-missing", runId: "r", userId: "u" })) as ScenarioResult;

    assert.equal(result.ok, false, "шаг с несуществующим текстом останавливает сценарий");
    assert.equal(result.documentStatus, 404);
    assert.match(result.diagnostic ?? "", /шаге 2|404/);
  } finally {
    await app.close();
  }
});
