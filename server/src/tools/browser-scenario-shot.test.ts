import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const data = await mkdtemp(path.join(os.tmpdir(), "webnestdev-scenario-shot-"));
process.env.WEBNESTDEV_DATA_DIR = data;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(data, "sandboxes");

const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { setPreview } = await import("../preview/preview-store.js");
await import("./browser-tools.js");
const { getTool } = await import("../tool-registry.js");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Катание</title>
<style>body{margin:0;font-family:sans-serif}.screen{width:390px;height:200px;background:#123}</style>
</head><body><div class="screen">Экран игры</div></body></html>`;

async function chromiumAvailable() {
  try {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

test("browser.scenario сохраняет снимок промежуточного шага в проект", async t => {
  if (!(await chromiumAvailable())) return t.skip("Chromium недоступен в этой среде");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const project = await createProject("Сценарий со снимком", undefined, "u-shot");
    setPreview({ mode: "static", containerId: "", host: "127.0.0.1", port, projectId: project.id, startedAt: Date.now(), lastUsedAt: Date.now() });
    const scenario = getTool("browser.scenario");
    assert.ok(scenario?.execute);
    const result = (await scenario.execute({
      path: "/",
      viewport: "mobile",
      steps: [
        { action: "expectText", text: "Экран игры" },
        { action: "screenshot", name: "ride" },
        { action: "expectText", text: "Экран игры" },
      ],
    }, { projectId: project.id, runId: "r", userId: "u-shot" })) as {
      ok: boolean;
      screenshots?: Array<{ step: number; path: string; url: string; bytes: number; layout?: { viewport: { width: number; height: number } } }>;
      diagnostic?: string;
    };

    assert.equal(result.ok, true, result.diagnostic ?? "");
    assert.equal(result.screenshots?.length, 1);
    const shot = result.screenshots?.[0];
    assert.equal(shot?.step, 2);
    assert.match(shot?.path ?? "", /^\.webnestdev\/screenshots\/ride-[a-z0-9]+\.png$/);
    assert.match(shot?.url ?? "", /^\/api\/projects\/.+\/screenshot\?path=/);
    assert.equal(shot?.layout?.viewport.width, 390);
    const bytes = await readFile(path.join(sandboxRootPath(project.id), shot?.path ?? ""));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.length, shot?.bytes);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
