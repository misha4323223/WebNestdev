import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";
import { chromium } from "playwright";

const MAX_BODY = 200_000;
const DEFAULT_PATH = "/";

registerTool({
  name: "browser.open",
  description:
    "Open the project's running Preview page over HTTP and return the status, headers, content type, and a bounded response body. Use this to inspect what the generated website actually serves. The URL is restricted to the current project's Preview.",
  execute: async (input, context) => {
    const status = await previewStatus(context.projectId);
    if (!status.running) {
      throw new Error(
        String((status as { error?: string }).error ?? "Preview is not running")
      );
    }

    const current = getPreview(context.projectId);
    if (!current) throw new Error("Preview state is unavailable");

    const requestedPath =
      typeof input === "object" &&
      input !== null &&
      typeof (input as { path?: unknown }).path === "string"
        ? (input as { path: string }).path
        : DEFAULT_PATH;

    const path = requestedPath.startsWith("/") ? requestedPath : "/" + requestedPath;
    const url = `http://${current.host}:3000${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
      });
      const body = (await response.text()).slice(0, MAX_BODY);

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: path,
        contentType: response.headers.get("content-type"),
        headers: Object.fromEntries(response.headers.entries()),
        truncated: body.length >= MAX_BODY,
        body,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to open Preview at ${path}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  },
});


registerTool({
  name: "browser.inspect",
  description:
    "Launch a headless browser against the project's running Preview and inspect the rendered page. Returns page title, final URL, console messages, JavaScript runtime errors, failed network requests, and a bounded text snapshot. Set screenshot=true to capture a PNG as a base64 string.",
  execute: async (input, context) => {
    const status = await previewStatus(context.projectId);
    if (!status.running) {
      throw new Error(
        String((status as { error?: string }).error ?? "Preview is not running")
      );
    }

    const current = getPreview(context.projectId);
    if (!current) throw new Error("Preview state is unavailable");

    const value =
      typeof input === "object" && input !== null
        ? (input as { path?: unknown; screenshot?: unknown })
        : {};
    const requestedPath =
      typeof value.path === "string" ? value.path : DEFAULT_PATH;
    const path = requestedPath.startsWith("/")
      ? requestedPath
      : "/" + requestedPath;
    const screenshot = value.screenshot === true;
    const url = `http://${current.host}:3000${path}`;

    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined,
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });

    const consoleMessages: Array<{ type: string; text: string }> = [];
    const runtimeErrors: string[] = [];
    const failedRequests: Array<{ url: string; error: string }> = [];
    const httpErrors: Array<{ url: string; status: number; statusText: string }> = [];

    page.on("console", message => {
      consoleMessages.push({
        type: message.type(),
        text: message.text().slice(0, 4000),
      });
    });
    page.on("pageerror", error => {
      runtimeErrors.push(error.message.slice(0, 4000));
    });
    page.on("response", response => {
      if (response.status() >= 400) {
        httpErrors.push({
          url: response.url().slice(0, 2000),
          status: response.status(),
          statusText: response.statusText().slice(0, 500),
        });
      }
    });
    page.on("requestfailed", request => {
      failedRequests.push({
        url: request.url().slice(0, 2000),
        error: request.failure()?.errorText ?? "unknown",
      });
    });

    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      const bodyText = (await page.locator("body").innerText()).slice(0, MAX_BODY);
      const result: Record<string, unknown> = {
        ok:
          Boolean(response?.ok()) &&
          runtimeErrors.length === 0 &&
          failedRequests.length === 0 &&
          httpErrors.length === 0,
        status: response?.status() ?? null,
        title: await page.title(),
        finalUrl: page.url(),
        console: consoleMessages.slice(-100),
        runtimeErrors: runtimeErrors.slice(-50),
        failedRequests: failedRequests.slice(-50),
        httpErrors: httpErrors.slice(-50),
        bodyText,
        truncated: bodyText.length >= MAX_BODY,
      };

      if (screenshot) {
        const buffer = await page.screenshot({ type: "png", fullPage: true });
        if (buffer.byteLength > 5_000_000) {
          throw new Error("Screenshot exceeds the 5 MB safety limit");
        }
        result.screenshotBase64 = buffer.toString("base64");
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to inspect Preview at ${path}: ${message}`);
    } finally {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  },
});
