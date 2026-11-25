import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installMetricsEnabled, installMetricsFile, recordInstallMetric } from "./install-metrics.js";

const metric = {
  at: 1_700_000_000_000,
  projectId: "p1",
  node: "n1",
  image: "node:26-bookworm",
  result: "ok" as const,
  cached: false,
  layer: false,
  mirror: true,
  durationMs: 12_345,
};

test("метрика дописывается строкой JSONL и каталог создаётся сам", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-metrics-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await recordInstallMetric(metric, { root, env: {} });
  await recordInstallMetric({ ...metric, projectId: "p2", cached: true, durationMs: 40 }, { root, env: {} });

  const lines = (await readFile(installMetricsFile(root), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), metric);
  assert.equal(JSON.parse(lines[1]).projectId, "p2");
  assert.equal(JSON.parse(lines[1]).cached, true);
});

test("метрику можно выключить, и тогда файла нет", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-metrics-off-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await recordInstallMetric(metric, { root, env: { WEBNESTDEV_INSTALL_METRICS: "0" } });
  await assert.rejects(readFile(installMetricsFile(root), "utf8"), /ENOENT/);
  assert.equal(installMetricsEnabled({ WEBNESTDEV_INSTALL_METRICS: "off" }), false);
  assert.equal(installMetricsEnabled({}), true);
});

test("сбой записи не превращается в ошибку установки", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-metrics-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // На месте каталога метрик лежит файл: создать каталог нельзя.
  await writeFile(path.join(root, "installs.jsonl"), "мусор", "utf8");

  await recordInstallMetric(metric, { root, env: {} });
});
