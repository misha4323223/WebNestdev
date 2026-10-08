import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";

const MAX_BODY = 200_000;
const MAX_DIAGNOSTIC_ITEMS = 100;
const DEFAULT_PATH = "/";

function getPath(input: unknown) {
  const requestedPath =
    typeof input === "object" &&
    input !== null &&
    typeof (input as { path?: unknown }).path === "string"
      ? (input as { path: string }).path
      : DEFAULT_PATH;
  return requestedPath.startsWith("/") ? requestedPath : "/" + requestedPath;
}

async function fetchPreview(projectId: string, path: string) {
  const status = await previewStatus(projectId);
  if (!status.running) {
    throw new Error(
      String((status as { error?: string }).error ?? "Preview is not running")
    );
  }

  const current = getPreview(projectId);
  if (!current) throw new Error("Preview state is unavailable");
  const url = `http://${current.host}:${current.port}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, MAX_BODY);
    return { response, body, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to open Preview at ${path}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function extractMatches(body: string, pattern: RegExp) {
  return [...body.matchAll(pattern)]
    .slice(0, MAX_DIAGNOSTIC_ITEMS)
    .map((match) => match[1] ?? match[0]);
}

function inspectHtml(body: string) {
  const scripts = extractMatches(body, /<script\b[^>]*?(?:src=["']([^"']+)["'][^>]*|)(?:\/>|>)/gi);
  const stylesheets = extractMatches(
    body,
    /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi
  );
  const links = extractMatches(body, /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi);
  const images = extractMatches(body, /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi);
  const title = body.match(/<title\b[^>]*>([\s\\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const errorSignals = [
    "Uncaught ",
    "Unhandled Runtime Error",
    "ChunkLoadError",
    "Failed to fetch",
    "Cannot read properties of",
    "is not defined",
  ].filter((signal) => body.includes(signal));

  return {
    title,
    scripts,
    stylesheets,
    links,
    images,
    errorSignals,
    counts: {
      scripts: scripts.length,
      stylesheets: stylesheets.length,
      links: links.length,
      images: images.length,
    },
  };
}

registerTool({
  name: "browser.open",
  description:
    "Open the project's running Preview page over HTTP and return status, headers, content type, bounded body, and basic HTML diagnostics. Use this to inspect what the generated website actually serves.",
  execute: async (input, context) => {
    const path = getPath(input);
    const { response, body } = await fetchPreview(context.projectId, path);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: path,
      contentType: response.headers.get("content-type"),
      headers: Object.fromEntries(response.headers.entries()),
      diagnostics:
        response.headers.get("content-type")?.toLowerCase().includes("text/html")
          ? inspectHtml(body)
          : null,
      truncated: body.length >= MAX_BODY,
      body,
    };
  },
});


import { chromium } from "playwright";

const MAX_CONSOLE_ITEMS = 100;
const MAX_NETWORK_ITEMS = 100;
const MAX_RUNTIME_MS = 20_000;
const MAX_SCREENSHOT_BYTES = 2_000_000;

async function inspectRuntimePage(projectId: string, path: string) {
  const status = await previewStatus(projectId);
  if (!status.running) {
    throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  }
  const current = getPreview(projectId);
  if (!current) throw new Error("Preview state is unavailable");

  const url = `http://${current.host}:${current.port}${path}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const failedRequests: Array<{ url: string; method: string; error: string }> = [];
  const httpErrors: Array<{ url: string; method: string; status: number }> = [];
  const pageErrors: string[] = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", message => {
      if (consoleMessages.length < MAX_CONSOLE_ITEMS) {
        consoleMessages.push({ type: message.type(), text: message.text().slice(0, 2000) });
      }
    });
    page.on("pageerror", error => {
      if (pageErrors.length < MAX_CONSOLE_ITEMS) pageErrors.push(error.message.slice(0, 2000));
    });
    page.on("response", response => {
      if (response.status() >= 400 && httpErrors.length < MAX_NETWORK_ITEMS) {
        httpErrors.push({ url: response.url().slice(0, 4000), method: response.request().method(), status: response.status() });
      }
    });
    page.on("requestfailed", request => {
      if (failedRequests.length < MAX_NETWORK_ITEMS) {
        failedRequests.push({
          url: request.url().slice(0, 4000),
          method: request.method(),
          error: request.failure()?.errorText ?? "request failed",
        });
      }
    });

    const runtimeDeadline = setTimeout(() => void page.close().catch(() => undefined), MAX_RUNTIME_MS);
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: MAX_RUNTIME_MS });
    const title = await page.title();
    const html = await page.content();
    const screenshot = await page.screenshot({ type: "png", fullPage: true, timeout: MAX_RUNTIME_MS });
    clearTimeout(runtimeDeadline);
    if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) {
      return {
        ok: false,
        status: response?.status() ?? null,
        statusText: response?.statusText() ?? null,
        url,
        title,
        console: consoleMessages,
        failedRequests,
        screenshotBase64: null,
        screenshotBytes: screenshot.byteLength,
        htmlBytes: Buffer.byteLength(html, "utf8"),
        diagnostic: "Screenshot exceeded the browser runtime size limit and was omitted.",
      };
    }
    return {
      ok: Boolean(response?.ok()) && consoleMessages.every(item => item.type !== "error") && pageErrors.length === 0 && failedRequests.length === 0 && httpErrors.length === 0,
      status: response?.status() ?? null,
      statusText: response?.statusText() ?? null,
      url,
      title,
      console: consoleMessages,
      failedRequests,
      httpErrors,
      pageErrors,
      screenshotBase64: screenshot.toString("base64"),
      screenshotBytes: screenshot.byteLength,
      htmlBytes: Buffer.byteLength(html, "utf8"),
    };
  } finally {
    await browser.close();
  }
}

import type { QaScenarioStep as BrowserScenarioStep } from "../qa/scenario-planner.js";

const MAX_SCENARIO_STEPS = 20;

async function runBrowserScenario(projectId: string, input: unknown) {
  const value = (input && typeof input === "object" ? input : {}) as {
    path?: unknown;
    steps?: unknown;
  };
  const initialPath = typeof value.path === "string" ? getPath({ path: value.path }) : "/";
  const steps = Array.isArray(value.steps) ? value.steps.slice(0, MAX_SCENARIO_STEPS) as BrowserScenarioStep[] : [];
  if (!steps.length) return { ok: false, error: "At least one scenario step is required." };

  const status = await previewStatus(projectId);
  if (!status.running) throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  const current = getPreview(projectId);
  if (!current) throw new Error("Preview state is unavailable");

  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ url: string; error: string }> = [];
  const httpErrors: Array<{ url: string; status: number }> = [];
  const results: Array<{ step: number; action: string; ok: boolean; detail?: string }> = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", message => { if (message.type() === "error" && consoleErrors.length < 50) consoleErrors.push(message.text().slice(0, 2000)); });
    page.on("pageerror", error => { if (pageErrors.length < 50) pageErrors.push(error.message.slice(0, 2000)); });
    page.on("response", response => { if (response.status() >= 400 && httpErrors.length < 50) httpErrors.push({ url: response.url().slice(0, 2000), status: response.status() }); });
    page.on("requestfailed", request => { if (failedRequests.length < 50) failedRequests.push({ url: request.url().slice(0, 2000), error: request.failure()?.errorText ?? "request failed" }); });

    await page.goto(`http://${current.host}:${current.port}${initialPath}`, { waitUntil: "networkidle", timeout: MAX_RUNTIME_MS });

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      try {
        switch (step.action) {
          case "goto":
            await page.goto(`http://${current.host}:${current.port}${getPath({ path: step.path })}`, { waitUntil: "networkidle", timeout: MAX_RUNTIME_MS });
            break;
          case "click": {
            const target = page.locator(step.selector).first();
            await target.waitFor({ state: "visible", timeout: 5000 });
            if (!(await target.isEnabled())) {
              throw new Error(`Element is visible but disabled: ${step.selector}`);
            }
            await target.click({ timeout: 5000 });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
            break;
          }
          case "fill":
            await page.locator(step.selector).first().fill(step.value, { timeout: 5000 });
            break;
          case "press":
            await page.locator(step.selector).first().press(step.key, { timeout: 5000 });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
            break;
          case "expectText":
            await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout: 5000 });
            break;
          case "expectUrl": {
            const matched = new RegExp(step.pattern).test(page.url());
            if (!matched) throw new Error(`URL did not match /${step.pattern}/: ${page.url()}`);
            break;
          }
          case "expectVisible":
            await page.locator(step.selector).first().waitFor({ state: "visible", timeout: 5000 });
            break;
          case "expectNotVisible":
            await page.locator(step.selector).first().waitFor({ state: "hidden", timeout: 5000 });
            break;
          default:
            throw new Error(`Unsupported scenario action: ${(step as { action?: string }).action ?? "unknown"}`);
        }
        results.push({ step: index + 1, action: step.action, ok: true });
      } catch (error) {
        results.push({ step: index + 1, action: step.action, ok: false, detail: error instanceof Error ? error.message : String(error) });
        break;
      }
    }

    const ok = results.length === steps.length && results.every(item => item.ok) && consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0 && httpErrors.length === 0;
    const screenshot = !ok ? await page.screenshot({ type: "png", fullPage: true, timeout: 5000 }).catch(() => null) : null;
    return { ok, initialPath, steps: results, finalUrl: page.url(), consoleErrors, pageErrors, failedRequests, httpErrors, screenshotBase64: screenshot ? screenshot.toString("base64") : null, diagnostic: ok ? "Browser scenario passed with no console, page, or network errors." : "Browser scenario failed; inspect the failed step, runtime diagnostics, and failure screenshot before retrying." };
  } finally {
    await browser.close();
  }
}

registerTool({
  name: "browser.scenario",
  description: "Run a real Chromium user-flow scenario against Preview. Input: {path?:string,steps:[{action:'goto',path}|{action:'click',selector}|{action:'fill',selector,value}|{action:'press',selector,key}|{action:'expectText',text}|{action:'expectUrl',pattern}|{action:'expectVisible',selector}|{action:'expectNotVisible',selector}]}. Maximum 20 steps. Supports visibility assertions, stops on the first failed step, and reports console/page/network errors.",
  execute: async (input, context) => runBrowserScenario(context.projectId, input),
});

registerTool({
  name: "browser.runtime",
  description:
    "Open the Preview in a real headless Chromium browser, execute client-side JavaScript, capture console errors, failed network requests, page title, and a PNG screenshot. Use this after browser.open or project.verify when runtime behavior matters.",
  execute: async (input, context) => inspectRuntimePage(context.projectId, getPath(input)),
});

registerTool({
  name: "browser.inspect",
  description:
    "Inspect a Preview HTML page without returning the full body. Reports title, loaded resource references, counts, and common error strings found in the server-rendered HTML. This does not claim to execute JavaScript.",
  execute: async (input, context) => {
    const path = getPath(input);
    const { response, body } = await fetchPreview(context.projectId, path);
    const contentType = response.headers.get("content-type");
    const isHtml = contentType?.toLowerCase().includes("text/html") ?? false;

    return {
      ok: response.ok && isHtml,
      status: response.status,
      statusText: response.statusText,
      url: path,
      contentType,
      htmlDiagnostics: isHtml ? inspectHtml(body) : null,
      note: "Diagnostics are derived from the HTTP response HTML; browser.inspect does not execute client-side JavaScript or capture a screenshot.",
    };
  },
});
