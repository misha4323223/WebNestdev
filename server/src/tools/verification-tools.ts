import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";

const MAX_BODY = 20_000;

registerTool({
  name: "project.verify",
  description:
    "Verify the current project after changes. Checks that Preview is running and requests the root page over HTTP. Returns a structured pass/fail diagnostic including status, content type, and bounded HTML. Use this after implementing or fixing a web task; if verification fails, inspect the diagnostic, fix the project, restart Preview when needed, and verify again.",
  execute: async (_input, context) => {
    const status = await previewStatus(context.projectId);
    if (!status.running) {
      return {
        ok: false,
        stage: "preview",
        reason: "Preview is not running",
        status,
        nextAction: "Call preview.start, inspect any startup error, fix the project, then run project.verify again.",
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`http://${current.host}:3000/`, {
        redirect: "manual",
        signal: controller.signal,
      });
      const body = (await response.text()).slice(0, MAX_BODY);

      const contentType = response.headers.get("content-type");
      const isHtml =
        contentType?.toLowerCase().includes("text/html") ?? false;
      const ok = response.ok && isHtml;

      return {
        ok,
        stage: "http",
        status: response.status,
        statusText: response.statusText,
        contentType,
        isHtml,
        body,
        truncated: body.length >= MAX_BODY,
        nextAction: ok
          ? "Verification passed. The Preview is running and the root page returned successful HTML."
          : "Verification failed. Inspect the HTTP status/content type and fix the project, then verify again.",
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
