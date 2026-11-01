import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "platform-models-"));
process.env.WEBNESTDEV_DATA_DIR = root;
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

const {
  deletePlatformModel,
  getPlatformModel,
  getPlatformModelForPlan,
  listPlatformModels,
  platformModelIdProblem,
  resolvePaidPlatformModel,
  savePlatformModel,
} = await import("./platform-models.js");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.WEBNESTDEV_DATA_DIR;
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
});

test("модель сохраняется с зашифрованным ключом и не отдаёт его наружу", async () => {
  const saved = await savePlatformModel("max", {
    name: "NestDev Max",
    description: "Для сложных задач",
    provider: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/",
    model: "anthropic/claude-sonnet",
    apiKey: "sk-max-secret",
    plans: ["pro", "team"],
  });
  assert.equal(saved.name, "NestDev Max");
  assert.equal(saved.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(saved.apiKey, "sk-max-secret");
  assert.deepEqual(saved.creditRates, { inputPerMillion: 250, outputPerMillion: 2_550, minimumPerRun: 2 });
  assert.deepEqual(saved.routing, {
    mode: "auto",
    providers: [],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
  });

  const listed = await listPlatformModels();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, "max");
  const file = await readFile(path.join(root, "platform", "models.json"), "utf8");
  assert.ok(!file.includes("sk-max-secret"), "ключ не должен лежать на диске открытым текстом");
});

test("ставки кредитов обновляются частично и возвращаются к стартовым по null", async () => {
  const updated = await savePlatformModel("max", { creditRates: { outputPerMillion: 3_000 } });
  assert.deepEqual(updated.creditRates, { inputPerMillion: 250, outputPerMillion: 3_000, minimumPerRun: 2 });
  const reset = await savePlatformModel("max", { creditRates: null });
  assert.deepEqual(reset.creditRates, { inputPerMillion: 250, outputPerMillion: 2_550, minimumPerRun: 2 });
});

test("обновление без ключа сохраняет старый, а clearKey удаляет его", async () => {
  const updated = await savePlatformModel("max", { name: "NestDev Max 2" });
  assert.equal(updated.name, "NestDev Max 2");
  assert.equal(updated.apiKey, "sk-max-secret");

  const cleared = await savePlatformModel("max", { clearKey: true });
  assert.equal(cleared.apiKey, undefined);
});

test("маршрутизация модели сохраняется, обновляется и сбрасывается в auto", async () => {
  const fixed = await savePlatformModel("max", { routing: { mode: "fixed", providers: ["morph/fp8", "open-inference/fp4"] } });
  assert.deepEqual(fixed.routing, {
    mode: "fixed",
    providers: ["morph/fp8", "open-inference/fp4"],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
  });
  assert.deepEqual((await getPlatformModel("max"))?.routing, fixed.routing);

  const cheapest = await savePlatformModel("max", { routing: { mode: "cheapest", providers: [], assumedInputPerOutput: 30 } });
  assert.equal(cheapest.routing.mode, "cheapest");
  assert.equal(cheapest.routing.assumedInputPerOutput, 30);

  await assert.rejects(
    savePlatformModel("max", { routing: { mode: "fixed", providers: [] } }),
    /routing:.*хотя бы одного/,
  );

  const reset = await savePlatformModel("max", { routing: null });
  assert.deepEqual(reset.routing, {
    mode: "auto",
    providers: [],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
  });
});

test("тариф решает, какая дополнительная модель доступна", async () => {
  await savePlatformModel("mini", {
    name: "NestDev Mini",
    provider: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    plans: ["pro"],
  });
  assert.equal((await getPlatformModelForPlan("max", "pro"))?.id, "max");
  assert.equal(await getPlatformModelForPlan("mini", "free"), null);
  assert.equal((await getPlatformModelForPlan("mini", "pro"))?.id, "mini");
  assert.equal(await getPlatformModelForPlan("mini", "team"), null);

  const main = { provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" };
  assert.equal((await resolvePaidPlatformModel("nestdev", "pro", main))?.id, "nestdev");
  assert.deepEqual((await resolvePaidPlatformModel("mini", "pro", main))?.creditRates, {
    inputPerMillion: 25,
    outputPerMillion: 255,
    minimumPerRun: 1,
  });
  assert.equal(await resolvePaidPlatformModel("mini", "team", main), null);
});

test("служебные id заняты, удаление убирает запись", async () => {
  assert.ok(platformModelIdProblem("nestdev"));
  assert.ok(platformModelIdProblem("nestdev-air"));
  assert.ok(platformModelIdProblem("Bad ID"));
  assert.equal(platformModelIdProblem("max"), null);

  assert.equal(await deletePlatformModel("mini"), true);
  assert.equal(await getPlatformModel("mini"), null);
  assert.equal(await deletePlatformModel("mini"), false);
});
