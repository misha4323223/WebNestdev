import test from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Маршруты очистки проверяются через настоящий HTTP-слой, но с подставным Docker: настоящие
 * `docker builder prune` в тестах запускать нельзя — они убирали бы кэш сборки машины, где идут
 * тесты. Подстановка заодно проверяет главное обещание контракта: в Docker уходят ровно две
 * команды и ни одна из них не трогает контейнеры и тома.
 *
 * Переменные выставляются до импорта: тип хранилища и каталог данных читаются при загрузке
 * admin-store, и подменить их после импорта было бы поздно.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-prune-"));

const Fastify = (await import("fastify")).default;
const { registerAdminPruneRoutes, PRUNE_COMMANDS, pruneKeep, pruneScope, reclaimedFromOutput } = await import("./admin-prune.js");
const { parseDockerDf } = await import("./admin-infra.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { listAudit } = await import("../security/audit-journal.js");

const EMAIL = "admin@example.test";
const PASSWORD = "correct-horse-battery";
const GB = 1_000_000_000;

const admin = await createAdmin(EMAIL, PASSWORD);
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

function dfLine(type: string, total: string, size: string, reclaimable: string) {
  return JSON.stringify({ Type: type, TotalCount: total, Size: size, Reclaimable: reclaimable });
}

const DF_BEFORE = [
  dfLine("Images", "12", "1GB", "200MB"),
  dfLine("Containers", "13", "0B", "0B"),
  dfLine("Local Volumes", "21", "5GB", "0B"),
  dfLine("Build Cache", "40", "12GB", "12GB"),
].join("\n");

const DF_AFTER = [
  dfLine("Images", "12", "1GB", "200MB"),
  dfLine("Containers", "13", "0B", "0B"),
  dfLine("Local Volumes", "21", "5GB", "0B"),
  dfLine("Build Cache", "0", "0B", "0B"),
].join("\n");

const DANGLING = [
  JSON.stringify({ ID: "sha256:aaa", Size: "1GB" }),
  JSON.stringify({ ID: "sha256:bbb", Size: "1GB" }),
].join("\n");

type StubConfig = {
  /** По одному ответу на каждый вызов `docker system df`; последний повторяется. */
  dfOutputs: string[];
  danglingOutput?: string;
  exited?: number;
  /** Docker не установлен: запуск отвечает `null`. */
  missing?: boolean;
  /** Команда, начинающаяся с этой строки, отвечает отказом. */
  failOn?: string;
};

function stubDocker(config: StubConfig) {
  const calls: string[][] = [];
  let dfIndex = 0;
  const docker = async (args: string[]) => {
    calls.push(args);
    if (config.missing) return null;
    const command = args.join(" ");
    if (command.startsWith("system df")) {
      const output = config.dfOutputs[Math.min(dfIndex, config.dfOutputs.length - 1)] ?? "";
      dfIndex += 1;
      return { code: 0, stdout: output, stderr: "" };
    }
    if (config.failOn && command.startsWith(config.failOn)) {
      return { code: 1, stdout: "", stderr: "docker: " + command + " не отработал" };
    }
    if (command.startsWith("image ls")) {
      return { code: 0, stdout: config.danglingOutput ?? "", stderr: "" };
    }
    if (command.startsWith("ps -aq")) {
      const exited = config.exited ?? 0;
      return { code: 0, stdout: Array.from({ length: exited }, (_, index) => "container-" + index).join("\n"), stderr: "" };
    }
    if (command.startsWith("builder prune")) {
      return { code: 0, stdout: "Deleted build cache objects:\nTotal reclaimed space: 12GB", stderr: "" };
    }
    if (command.startsWith("image prune")) {
      return { code: 0, stdout: "Deleted Images:\nTotal reclaimed space: 1GB", stderr: "" };
    }
    // Ни контейнеры, ни тома, ни `system prune` сюда попадать не должны: такой вызов вернул бы
    // отказ, и это сразу видно в тесте, который проверяет состав команд.
    return { code: 1, stdout: "", stderr: "неожиданная команда: " + command };
  };
  return { docker, calls };
}

async function makeApp(config: StubConfig, now?: () => number) {
  const stub = stubDocker(config);
  const app = Fastify();
  await registerAdminPruneRoutes(app, now ? { docker: stub.docker, now } : { docker: stub.docker });
  return { app, stub };
}

function post(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: "POST", url: "/api/admin/infra/prune", headers: auth, payload: payload as never });
}

test("без админ-токена очистка не отвечает и Docker не запускается", async () => {
  const { app, stub } = await makeApp({ dfOutputs: [DF_BEFORE] });
  const get = await app.inject({ method: "GET", url: "/api/admin/infra/prune" });
  assert.equal(get.statusCode, 401);
  const create = await app.inject({ method: "POST", url: "/api/admin/infra/prune", payload: { confirm: true } });
  assert.equal(create.statusCode, 401);
  assert.deepEqual(stub.calls, []);
});

test("GET считает безопасную часть отдельно от холодных песочниц и томов", async () => {
  const { app } = await makeApp({ dfOutputs: [DF_BEFORE], danglingOutput: DANGLING, exited: 13 });
  const response = await app.inject({ method: "GET", url: "/api/admin/infra/prune", headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    generatedAt: string;
    scope: { builderCacheBytes: number; danglingImages: { count: number; bytes: number }; safeTotalBytes: number };
    keep: { stoppedContainers: number; volumes: { count: number; bytes: number } };
    commands: string[];
    canRun: boolean;
  };
  assert.deepEqual(body.scope, {
    builderCacheBytes: 12 * GB,
    danglingImages: { count: 2, bytes: 2 * GB },
    safeTotalBytes: 14 * GB,
  });
  assert.deepEqual(body.keep, { stoppedContainers: 13, volumes: { count: 21, bytes: 5 * GB } });
  assert.deepEqual(body.commands, [...PRUNE_COMMANDS]);
  assert.equal(body.canRun, true);
  assert.equal(typeof body.generatedAt, "string");
  assert.equal("reason" in body, false, "при рабочем Docker причины отказа нет");
});

test("GET блокирует кнопку, когда Docker недоступен", async () => {
  const { app } = await makeApp({ dfOutputs: [DF_BEFORE], missing: true });
  const response = await app.inject({ method: "GET", url: "/api/admin/infra/prune", headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { canRun: boolean; reason: string; scope: { safeTotalBytes: number } };
  assert.equal(body.canRun, false);
  assert.match(body.reason, /Docker недоступен/);
  assert.equal(body.scope.safeTotalBytes, 0);
});

test("GET не показывает кнопку, если не прочитаны образы или контейнеры", async () => {
  const danglingFailed = await makeApp({ dfOutputs: [DF_BEFORE], failOn: "image ls" });
  const first = await danglingFailed.app.inject({ method: "GET", url: "/api/admin/infra/prune", headers: auth });
  const firstBody = first.json() as { canRun: boolean; reason: string };
  assert.equal(firstBody.canRun, false);
  assert.match(firstBody.reason, /висячих образов/);

  const containersFailed = await makeApp({ dfOutputs: [DF_BEFORE], failOn: "ps -aq" });
  const second = await containersFailed.app.inject({ method: "GET", url: "/api/admin/infra/prune", headers: auth });
  const secondBody = second.json() as { canRun: boolean; reason: string };
  assert.equal(secondBody.canRun, false);
  assert.match(secondBody.reason, /холодных песочниц/);
});

test("POST принимает только подтверждение: «области» отвечают 400 и до Docker не доходят", async () => {
  const { app, stub } = await makeApp({ dfOutputs: [DF_BEFORE, DF_AFTER] });
  for (const payload of [{}, { confirm: false }, { scope: "volumes" }, { confirm: true, scope: "volumes" }]) {
    const response = await post(app, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(response.json(), { error: "Нужно подтверждение: { confirm: true }" });
  }
  assert.deepEqual(stub.calls, []);
});

test("POST запускает ровно две команды и не трогает контейнеры и тома", async () => {
  const { app, stub } = await makeApp({ dfOutputs: [DF_BEFORE, DF_AFTER], danglingOutput: DANGLING, exited: 13 });
  const response = await post(app, { confirm: true });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    freedBytes: number;
    beforeBytes: number;
    afterBytes: number;
    ranAt: string;
    details: string[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.beforeBytes, 18 * GB);
  assert.equal(body.afterBytes, 6 * GB);
  assert.equal(body.freedBytes, 12 * GB);
  assert.equal(body.details.length, 2);
  assert.match(body.details[0], /^builder prune: /);
  assert.match(body.details[1], /^image prune: /);
  assert.equal(typeof body.ranAt, "string");

  const executed = stub.calls.filter(args => !args.join(" ").startsWith("system df"));
  assert.deepEqual(executed, [
    ["builder", "prune", "-a", "-f"],
    ["image", "prune", "-f"],
  ]);
  for (const args of stub.calls) {
    assert.ok(!/container|volume|system\s+prune/.test(args.join(" ")), "чужие объекты не удаляются: " + args.join(" "));
  }

  // Удаление на сервере должно быть видно постфактум — отдельным действием журнала.
  const events = await listAudit({ action: "infra.docker.pruned" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actorId, admin.id);
  assert.equal(events[0].details.freedBytes, 12 * GB);
});

test("отказ prune не выдаётся за успех", async () => {
  const { app } = await makeApp({ dfOutputs: [DF_BEFORE, DF_AFTER], failOn: "builder prune" });
  const response = await post(app, { confirm: true });
  assert.equal(response.statusCode, 502);
  const body = response.json() as { error: string; details: string };
  assert.match(body.error, /builder prune/);
  assert.match(body.details, /не отработал/);
});

test("повторная очистка в течение 30 секунд отклоняется", async () => {
  let clock = 1_000_000;
  const { app } = await makeApp({ dfOutputs: [DF_BEFORE, DF_AFTER] }, () => clock);

  const first = await post(app, { confirm: true });
  assert.equal(first.statusCode, 200);

  clock += 1_000;
  const second = await post(app, { confirm: true });
  assert.equal(second.statusCode, 429);
  assert.equal(second.headers["retry-after"], "29");

  clock += 30_000;
  const third = await post(app, { confirm: true });
  assert.equal(third.statusCode, 200);
});

test("freedBytes берётся из вывода команд, когда docker system df не разобран", async () => {
  const { app } = await makeApp({ dfOutputs: [DF_BEFORE, "это не таблица docker"] });
  const response = await post(app, { confirm: true });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { freedBytes: number; beforeBytes: number; afterBytes: number };
  assert.equal(body.freedBytes, 13 * GB, "12 ГБ кэша и 1 ГБ образов из вывода команд");
  assert.equal(body.beforeBytes, 18 * GB);
  assert.equal(body.afterBytes, 0, "неизвестный итог после уборки не выдумывается");
});

test("итог prune читается и без слова reclaimed", () => {
  assert.equal(reclaimedFromOutput("Total reclaimed space: 1.5GB"), 1_500_000_000);
  assert.equal(reclaimedFromOutput("Total: 0B"), 0);
  assert.equal(reclaimedFromOutput("Deleted build cache objects:\n"), null);
});

test("в безопасную часть входит только то, что маршрут вправе удалить", () => {
  const rows = parseDockerDf(DF_BEFORE);
  assert.deepEqual(pruneScope(rows, { count: 2, bytes: 2 * GB }), {
    builderCacheBytes: 12 * GB,
    danglingImages: { count: 2, bytes: 2 * GB },
    safeTotalBytes: 14 * GB,
  });
  assert.deepEqual(pruneKeep(rows, 13), { stoppedContainers: 13, volumes: { count: 21, bytes: 5 * GB } });
});
