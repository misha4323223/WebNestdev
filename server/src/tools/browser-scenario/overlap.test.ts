import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const data = await mkdtemp(path.join(os.tmpdir(), "webnestdev-scenario-overlap-"));
process.env.WEBNESTDEV_DATA_DIR = data;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(data, "sandboxes");

const { createProject } = await import("../../project-store.js");
const { setPreview } = await import("../../preview/preview-store.js");
await import("../browser-tools.js");
const { getTool } = await import("../../tool-registry.js");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Overlap</title>
<style>
  body{margin:0;font-family:sans-serif}
  #hit{position:absolute;left:40px;top:40px;width:120px;height:48px;z-index:1}
  #cover{position:absolute;left:0;top:0;width:100%;height:100%;z-index:10;background:transparent}
</style></head><body>
<button id="hit">Ударить</button><div id="cover" aria-hidden="true"></div>
</body></html>`;

async function chromiumAvailable() {
  try {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

test("провал клика отдаёт elementFromPoint, перекрывающий слой и call log", async t => {
  if (!(await chromiumAvailable())) return t.skip("Chromium недоступен в этой среде");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const project = await createProject("Overlap scenario", undefined, "u-overlap");
    setPreview({ mode: "static", containerId: "", host: "127.0.0.1", port, projectId: project.id, startedAt: Date.now(), lastUsedAt: Date.now() });
    const scenario = getTool("browser.scenario");
    assert.ok(scenario?.execute);
    const result = (await scenario.execute({
      path: "/",
      timeoutMs: 5_000,
      steps: [
        { action: "click", selector: "#hit", timeoutMs: 300 },
      ],
    }, { projectId: project.id, runId: "r", userId: "u-overlap" })) as {
      ok: boolean;
      failedStep?: {
        detail?: string;
        callLog?: string;
        overlap?: { top?: { id?: string; zIndex?: string }; point?: { x: number; y: number } };
        screenshot?: { path?: string };
      };
      screenshots?: Array<{ path?: string }>;
    };

    assert.equal(result.ok, false);
    assert.match(result.failedStep?.detail ?? "", /waiting for|intercepts pointer events|Timeout/);
    assert.match(result.failedStep?.callLog ?? "", /locator\.click|Call log|Timeout/);
    assert.equal(result.failedStep?.overlap?.top?.id, "cover");
    assert.equal(result.failedStep?.overlap?.top?.zIndex, "10");
    assert.ok(result.failedStep?.overlap?.point);
    assert.match(result.failedStep?.screenshot?.path ?? "", /^\.webnestdev\/screenshots\/failure-/);
    assert.ok(result.screenshots?.some(item => item.path === result.failedStep?.screenshot?.path));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
