import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";

const MAX_BODY = 200_000;
const DEFAULT_PATH = "/";

registerTool({
  name: "browser.open",
  description:
    "Open the project's running Preview page over HTTP and return the status, headers, content type, and a bounded response body. Use this to inspect what the generated website actually serves. The URL is restricted to the current project's Preview.",
  async (input, context) {
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
