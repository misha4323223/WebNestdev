import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";

const MAX_BODY = 20_000;

registerTool({
  name: "project.verify",
  description:
    "Verify the current project after changes. Checks Preview health, successful HTML, a non-empty document, and common server-rendered error signals. Returns structured pass/fail diagnostics. Use this after implementing or fixing a web task; if verification fails, inspect the failed checks, fix the project, and verify again.",
  execute: async (_input, context) => {
    const status = await previewStatus(context.projectId);
    if (!status.running) {
      return {
        ok: false,
        stage: "preview",
        reason: "Preview is not running",
        status,
        nextAction:
          "Call preview.start, inspect any startup error, fix the project, then run project.verify again.",
      };
    }

    const current = getPreview(context.projectId);
    if (!current) {
      return {
        ok: false,
        stage: "preview",
        reason: "Preview state is unavailable",
        nextAction: "Restart the Preview and run project.verify again.",
      };
    }

    if (!current.port) {
      return {
        ok: false,
        stage: "preview",
        reason: "Preview is running but its host port is unavailable",
        nextAction: "Restart the Preview and run project.verify again.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`http://${current.host}:${current.port}/`, {
        redirect: "manual",
        signal: controller.signal,
      });
      const body = (await response.text()).slice(0, MAX_BODY);
      const contentType = response.headers.get("content-type");
      const isHtml = contentType?.toLowerCase().includes("text/html") ?? false;
      const trimmedBody = body.trim();
      const hasDocument = /<html\b/i.test(body) && /<body\b/i.test(body);
      const hasRuntimeErrorSignal = [
        "Internal Server Error",
        "Application Error",
        "Unhandled Runtime Error",
        "Cannot read properties of",
        "ReferenceError:",
        "TypeError:",
      ].some((signal) => body.includes(signal));

      const checks = {
        httpOk: response.ok,
        htmlContentType: isHtml,
        nonEmptyBody: trimmedBody.length > 0,
        htmlDocument: hasDocument,
        noRuntimeErrorSignal: !hasRuntimeErrorSignal,
      };
      const ok = Object.values(checks).every(Boolean);

      return {
        ok,
        stage: "http",
        status: response.status,
        statusText: response.statusText,
        contentType,
        checks,
        body,
        truncated: body.length >= MAX_BODY,
        nextAction: ok
          ? "Verification passed. Preview returned a non-empty HTML document without common server-rendered error signals."
          : "Verification failed. Inspect the failed checks, HTTP response, or error signals, fix the project, then verify again.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stage: "http",
        reason: `Unable to reach Preview: ${message}`,
        nextAction:
          "Inspect Preview startup/runtime diagnostics, fix the project, restart Preview if needed, then run project.verify again.",
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
