import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { setPreview } from "../preview/preview-store.js";
import { getTool } from "../tool-registry.js";
import "./perf-tools.js";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Игра</title>
<style>body{margin:0;background:#0b1020;color:#fff}</style></head><body>
<h1>Катание</h1><canvas width="320" height="180"></canvas>
<script>const c=document.querySelector("canvas").getContext("2d");let x=0;function draw(){x=(x+2)%320;c.fillStyle="#123";c.fillRect(0,0,320,180);c.fillStyle="#fff";c.fillRect(x,80,20,20);requestAnimationFrame(draw)}draw();</script>
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

test("browser.perf возвращает FPS и метрики, а не только «страница открылась»", async t => {
  if (!(await chromiumAvailable())) return t.skip("Chromium недоступен в этой среде");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    setPreview({ mode: "static", containerId: "", host: "127.0.0.1", port, projectId: "p-perf", startedAt: Date.now(), lastUsedAt: Date.now() });
    const tool = getTool("browser.perf");
    assert.ok(tool?.execute);
    const result = (await tool.execute({ path: "/", durationMs: 600 }, { projectId: "p-perf", runId: "r", userId: "" })) as {
      ok: boolean;
      fps: number;
      frames: number;
      longTasks: { count: number };
      lcpMs: number;
      cls: number;
      navigation: { resourceCount: number; transferBytes: number };
      note: string;
    };
    assert.equal(result.ok, true);
    assert.ok(result.fps > 0, "FPS должен быть измерен, а не остаться нулём: " + result.fps);
    assert.ok(result.frames > 0);
    assert.ok(Number.isInteger(result.longTasks.count), "long tasks должны быть числом");
    assert.match(result.note, /headless/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
