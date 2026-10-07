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

async function inspectRuntimePage(projectId: string, path: string) {
  const status = await previewStatus(projectId);
  if (!status.running) {
    throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  }
  const current = getPreview(projectId);
  if (!current) throw new Error("Preview state is unavailable");

  const url = `http://${current.host}:${current.port}${path}`;
  const browser = await chromium.launch({ headless: true });
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const failedRequests: Array<{ url: string; method: string; error: string }> = [];

  try {
    const page = await browser.newPage();
    page.on("console", message => {
      if (consoleMessages.length < MAX_CONSOLE_ITEMS) {
        consoleMessages.push({ type: message.type(), text: message.text().slice(0, 2000) });
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

    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    const title = await page.title();
    const html = await page.content();
    const screenshot = await page.screenshot({ type: "png", fullPage: true });
    return {
      ok: Boolean(response?.ok()) && consoleMessages.every(item => item.type !== "error") && failedRequests.length === 0,
      status: response?.status() ?? null,
      statusText: response?.statusText() ?? null,
      url,
      title,
      console: consoleMessages,
      failedRequests,
      screenshotBase64: screenshot.toString("base64"),
      screenshotBytes: screenshot.byteLength,
      htmlBytes: Buffer.byteLength(html, "utf8"),
    };
  } finally {
    await browser.close();
  }
}

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
