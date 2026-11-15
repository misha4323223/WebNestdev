import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { previewDoorToken } from "./door-token.js";

const data = await mkdtemp(path.join(os.tmpdir(), "webnestdev-preview-logs-"));
process.env.WEBNESTDEV_DATA_DIR = data;
process.env.WEBNESTDEV_ENCRYPTION_KEY = "a".repeat(64);

const { previewLogs } = await import("../preview-manager.js");
const { getPreview, removePreview, setPreview } = await import("./preview-store.js");

test("preview.logs на чужой реплике берёт static-логи у ноды-владельца", async t => {
  const seen: Array<{ url: string; authorization: string }> = [];
  const owner = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push({
        url: request.url ?? "",
        authorization: String(request.headers.authorization ?? ""),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ running: true, logs: "remote build output" }));
    });
  });
  await new Promise<void>(resolve => owner.listen(0, "127.0.0.1", resolve));
  const address = owner.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const projectId = "remote-logs-project";
  setPreview({
    mode: "static",
    containerId: "",
    host: "127.0.0.1",
    port: 3000,
    projectId,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    ownerAddress: "localhost:" + port,
    ready: true,
    settled: true,
  });
  t.after(async () => {
    if (getPreview(projectId)) removePreview(projectId);
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  });

  const result = await previewLogs(projectId, { touch: false });
  assert.equal(result.running, true);
  assert.match(result.logs, /remote build output/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "/__internal/preview/logs");
  assert.equal(seen[0]?.authorization, "Bearer " + (previewDoorToken() ?? ""));

  // Внутренний маршрут двери обязан оставаться локальным: иначе при нераспознанном
  // ownerAddress он снова пошёл бы в дверь и замкнул бы запрос.
  await previewLogs(projectId, { touch: false, localOnly: true });
  assert.equal(seen.length, 1);
});
