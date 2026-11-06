import test from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Список версий выкатки проверяется через настоящий HTTP-слой с подставным Docker: удалять образы
 * машины, где идут тесты, нельзя. Подстановка заодно проверяет главное обещание контракта —
 * активная версия не удаляется никогда, а зависшая без `containers=remove` не трогается.
 *
 * Переменные выставляются до импорта: тип хранилища читается при загрузке admin-store.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-releases-"));

const Fastify = (await import("fastify")).default;
const {
  registerAdminReleasesRoutes,
  buildReleaseInventory,
  parseContainerLines,
  parseDockerDate,
  parseImageLines,
  releaseConfig,
  refRepository,
} = await import("./admin-releases.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { listAudit } = await import("../security/audit-journal.js");

const GB = 1_000_000_000;
const NOW = Date.parse("2026-11-07T00:00:00Z");

const EMAIL = "admin@releases.test";
const PASSWORD = "correct-horse-battery";
const admin = await createAdmin(EMAIL, PASSWORD);
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

const REPO = "ghcr.io/x/webnestdev";
const IMAGE_ACTIVE = "sha256:" + "a".repeat(64);
const IMAGE_STUCK = "sha256:" + "b".repeat(64);
const IMAGE_PREVIOUS = "sha256:" + "c".repeat(64);
const IMAGE_OLD = "sha256:" + "d".repeat(64);

function imageLine(id: string, repo: string, tag: string, size: string, createdAt: string) {
  return JSON.stringify({ ID: id, Repository: repo, Tag: tag, Digest: "<none>", Size: size, CreatedAt: createdAt, CreatedSince: createdAt });
}

const IMAGES = [
  // Работающая версия; у неё два тега — в листинге это две строки с одним ID.
  imageLine(IMAGE_ACTIVE, REPO, "sha-aaaaaaaaaaaa", "1.45GB", "2026-11-06 21:00:00 +0300 MSK"),
  imageLine(IMAGE_ACTIVE, REPO, "latest", "1.45GB", "2026-11-06 21:00:00 +0300 MSK"),
  // Зависшая: её держит контейнер команды агента, который не доехал до старта.
  imageLine(IMAGE_STUCK, REPO, "sha-bbbbbbbbbbbb", "1.45GB", "2026-11-05 21:00:00 +0300 MSK"),
  // Окно откката, ничего не держит.
  imageLine(IMAGE_PREVIOUS, REPO, "sha-cccccccccccc", "1.45GB", "2026-11-04 21:00:00 +0300 MSK"),
  // Сверх окна — мусор.
  imageLine(IMAGE_OLD, REPO, "sha-dddddddddddd", "1.2GB", "2026-11-03 21:00:00 +0300 MSK"),
  // Базовый образ песочниц: на него окно откката не распространяется.
  imageLine("sha256:" + "e".repeat(64), "node", "22-bookworm", "1.64GB", "2026-10-20 10:00:00 +0300 MSK"),
  // Висячий слой — забота очистки Docker, а не списка версий.
  imageLine("sha256:" + "f".repeat(64), "<none>", "<none>", "900MB", "2026-10-01 10:00:00 +0300 MSK"),
].join("\n");

function containerLine(id: string, name: string, state: string, image: string) {
  return JSON.stringify({ ID: id, Names: name, State: state, Image: image, CreatedAt: "2026-11-06 20:00:00 +0300 MSK" });
}

const CONTAINERS = [
  containerLine("111111111111", "wnd-preview-active", "running", REPO + ":sha-aaaaaaaaaaaa"),
  containerLine("222222222222", "wnd-cmd-stuck", "created", REPO + ":sha-bbbbbbbbbbbb"),
].join("\n");

function dfLine(type: string, total: string, size: string, reclaimable: string) {
  return JSON.stringify({ Type: type, TotalCount: total, Size: size, Reclaimable: reclaimable });
}

const DF_BEFORE = [dfLine("Images", "6", "5GB", "3GB")].join("\n");
const DF_AFTER = [dfLine("Images", "5", "3.8GB", "1.8GB")].join("\n");

type StubConfig = {
  images?: string;
  containers?: string;
  /** По одному ответу на каждый `docker system df`; последний повторяется. */
  df?: string[];
  /** Команда, начинающаяся с этой строки, отвечает отказом. */
  failOn?: string;
  missing?: boolean;
};

function stubDocker(config: StubConfig) {
  const calls: string[][] = [];
  let dfIndex = 0;
  const docker = async (args: string[]) => {
    calls.push(args);
    if (config.missing) return null;
    const command = args.join(" ");
    if (command.startsWith("images --no-trunc")) return { code: 0, stdout: config.images ?? "", stderr: "" };
    if (command.startsWith("ps -a")) return { code: 0, stdout: config.containers ?? "", stderr: "" };
    if (command.startsWith("system df")) {
      const outputs = config.df ?? [DF_BEFORE];
      const output = outputs[Math.min(dfIndex, outputs.length - 1)] ?? "";
      dfIndex += 1;
      return { code: 0, stdout: output, stderr: "" };
    }
    if (config.failOn && command.startsWith(config.failOn)) {
      return { code: 1, stdout: "", stderr: "docker: " + command + " не отработал" };
    }
    if (command.startsWith("rm -f")) return { code: 0, stdout: "222222222222", stderr: "" };
    if (command.startsWith("rmi")) return { code: 0, stdout: "Deleted: " + args[1], stderr: "" };
    return { code: 1, stdout: "", stderr: "неожиданная команда: " + command };
  };
  return { docker, calls };
}

async function makeApp(config: StubConfig) {
  const stub = stubDocker(config);
  const app = Fastify();
  await registerAdminReleasesRoutes(app, {
    docker: stub.docker,
    now: () => NOW,
    env: { PLATFORM_RELEASES_KEEP: "3" } as NodeJS.ProcessEnv,
    disk: async () => ({ totalBytes: 48 * GB, usedBytes: 13 * GB, freeBytes: 35 * GB }),
  });
  return { app, stub };
}

function get(app: FastifyInstance) {
  return app.inject({ method: "GET", url: "/api/admin/releases", headers: auth });
}

function del(app: FastifyInstance, id: string, query = "confirm=1") {
  const url = "/api/admin/releases/" + encodeURIComponent(id) + "?" + query;
  return app.inject({ method: "DELETE", url, headers: auth });
}

test("без админ-токена список и удаление не отвечают и Docker не запускается", async () => {
  const { app, stub } = await makeApp({ images: IMAGES, containers: CONTAINERS });
  const list = await app.inject({ method: "GET", url: "/api/admin/releases" });
  assert.equal(list.statusCode, 401);
  const remove = await app.inject({ method: "DELETE", url: "/api/admin/releases/" + encodeURIComponent(IMAGE_OLD) + "?confirm=1" });
  assert.equal(remove.statusCode, 401);
  assert.deepEqual(stub.calls, []);
});

test("GET показывает четыре состояния версии и не считает базовые образы релизами", async () => {
  const { app } = await makeApp({ images: IMAGES, containers: CONTAINERS });
  const response = await get(app);
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    keep: number;
    available: boolean;
    releases: Array<{
      id: string;
      tags: string[];
      status: string;
      rank: number;
      kept: boolean;
      canDelete: boolean;
      holders: Array<{ name: string }>;
      buildSha: string | null;
    }>;
    summary: { count: number; totalBytes: number; deletableBytes: number; stuckBytes: number; activeBytes: number };
    disk: { totalBytes: number; usedBytes: number };
    docker: { imagesBytes: number } | null;
  };

  assert.equal(body.keep, 3);
  assert.equal(body.available, true);
  assert.equal(body.releases.length, 4, "основной образ, базовый node и висячий слой не считаются релизами");

  const byStatus = new Map(body.releases.map(release => [release.status, release]));
  assert.deepEqual([...byStatus.keys()].sort(), ["active", "old", "previous", "stuck"]);

  const active = byStatus.get("active")!;
  assert.equal(active.id, IMAGE_ACTIVE);
  assert.equal(active.rank, 1);
  assert.equal(active.kept, true);
  assert.equal(active.canDelete, false);
  assert.deepEqual(active.tags.sort(), [REPO + ":latest", REPO + ":sha-aaaaaaaaaaaa"], "два тега — одна версия");
  assert.equal(active.buildSha, "aaaaaaaaaaaa");

  const stuck = byStatus.get("stuck")!;
  assert.equal(stuck.id, IMAGE_STUCK);
  assert.equal(stuck.kept, true, "зависшая версия может быть внутри окна откката");
  assert.equal(stuck.canDelete, true);
  assert.deepEqual(stuck.holders.map(holder => holder.name), ["wnd-cmd-stuck"]);

  assert.equal(byStatus.get("previous")!.id, IMAGE_PREVIOUS);
  assert.equal(byStatus.get("old")!.id, IMAGE_OLD);
  assert.equal(byStatus.get("old")!.rank, 4);

  assert.equal(body.summary.count, 4);
  assert.equal(body.summary.totalBytes, 1_450_000_000 * 3 + 1_200_000_000);
  assert.equal(body.summary.activeBytes, 1_450_000_000);
  assert.equal(body.summary.stuckBytes, 1_450_000_000);
  assert.equal(body.summary.deletableBytes, 1_450_000_000 + 1_200_000_000, "откат и старьё освобождаются удалением");

  // Занятое всем разделом и образы Docker — разные числа: из-за их смешения и казалось, что уборка
  // ничего не освободила.
  assert.equal(body.disk.usedBytes, 13 * GB);
  assert.equal(body.docker?.imagesBytes, 5 * GB);
});

test("без Docker список честно помечен недоступным, а не пустым", async () => {
  const { app } = await makeApp({ missing: true });
  const response = await get(app);
  assert.equal(response.statusCode, 200);
  const body = response.json() as { available: boolean; reason: string; releases: unknown[] };
  assert.equal(body.available, false);
  assert.match(body.reason, /docker images/);
  assert.deepEqual(body.releases, []);
});

test("удаление без подтверждения отвечает 400 и Docker не трогает", async () => {
  const { app, stub } = await makeApp({ images: IMAGES, containers: CONTAINERS });
  for (const query of ["", "confirm=0", "confirm=1&containers=all"]) {
    const response = await del(app, IMAGE_OLD, query);
    assert.equal(response.statusCode, 400, query);
  }
  assert.deepEqual(stub.calls, []);
});

test("активную версию удалить нельзя: это остановка сайта", async () => {
  const { app, stub } = await makeApp({ images: IMAGES, containers: CONTAINERS });
  const response = await del(app, IMAGE_ACTIVE);
  assert.equal(response.statusCode, 409);
  const body = response.json() as { error: string; activeContainers: Array<{ name: string }> };
  assert.match(body.error, /работает/);
  assert.deepEqual(body.activeContainers.map(holder => holder.name), ["wnd-preview-active"]);
  assert.equal(stub.calls.filter(args => args[0] === "rmi").length, 0);
});

test("зависшую версию без containers=remove не трогают, а с ним снимают контейнер", async () => {
  const blocked = await makeApp({ images: IMAGES, containers: CONTAINERS });
  const refused = await del(blocked.app, "bbbbbbbbbbbb");
  assert.equal(refused.statusCode, 409);
  const refusedBody = refused.json() as { error: string; holders: Array<{ name: string; removable: boolean }> };
  assert.match(refusedBody.error, /containers=remove/);
  assert.deepEqual(refusedBody.holders, [
    { id: "222222222222", shortId: "222222222222", name: "wnd-cmd-stuck", state: "created", createdAt: "2026-11-06T17:00:00.000Z", removable: true },
  ]);
  assert.equal(blocked.stub.calls.filter(args => args[0] === "rmi").length, 0);

  const allowed = await makeApp({ images: IMAGES, containers: CONTAINERS, df: [DF_BEFORE, DF_BEFORE, DF_AFTER] });
  const removed = await del(allowed.app, "bbbbbbbbbbbb", "confirm=1&containers=remove");
  assert.equal(removed.statusCode, 200, removed.body);
  const body = removed.json() as {
    ok: boolean;
    removedContainers: string[];
    freedBytes: number;
    summary: { count: number; stuckBytes: number };
    releases: Array<{ id: string }>;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.removedContainers, ["wnd-cmd-stuck"]);
  assert.equal(body.freedBytes, 1_200_000_000, "5 ГБ было, 3.8 ГБ стало");
  assert.equal(body.releases.length, 4, "удалённый образ не возвращается в списке");

  const order = allowed.stub.calls.map(args => args.join(" ")).filter(call => call.startsWith("rm "));
  assert.deepEqual(order, ["rm -f 222222222222"], "сначала контейнер, потом образ");
  const rmiIndex = allowed.stub.calls.findIndex(args => args[0] === "rmi");
  const rmIndex = allowed.stub.calls.findIndex(args => args[0] === "rm");
  assert.ok(rmIndex < rmiIndex);

  const events = await listAudit({ action: "infra.release.deleted" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actorId, admin.id);
  assert.equal(events[0].details.buildSha, "bbbbbbbbbbbb");
  assert.equal(events[0].details.removedContainers, "wnd-cmd-stuck");
});

test("старую версию удаляют одним вызовом rmi и отдают освобождённые байты", async () => {
  const { app, stub } = await makeApp({ images: IMAGES, containers: CONTAINERS, df: [DF_BEFORE, DF_BEFORE, DF_AFTER] });
  const response = await del(app, IMAGE_OLD);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { deleted: { id: string; status: string }; freedBytes: number; removedContainers: string[] };
  assert.equal(body.deleted.id, IMAGE_OLD);
  assert.equal(body.deleted.status, "old");
  assert.equal(body.freedBytes, 1_200_000_000);
  assert.deepEqual(body.removedContainers, [], "контейнеров у старой версии нет");
  assert.deepEqual(
    stub.calls.filter(args => args[0] === "rmi").map(args => args.slice(0, 2)),
    [["rmi", IMAGE_OLD]],
  );
});

test("неизвестная версия и отказ Docker не выдаются за успех", async () => {
  const { app } = await makeApp({ images: IMAGES, containers: CONTAINERS });
  const missing = await del(app, "deadbeefcafe");
  assert.equal(missing.statusCode, 404);
  assert.match((missing.json() as { error: string }).error, /нет на диске/);

  const failed = await makeApp({ images: IMAGES, containers: CONTAINERS, failOn: "rmi" });
  const refusal = await del(failed.app, IMAGE_OLD);
  assert.equal(refusal.statusCode, 409);
  const body = refusal.json() as { error: string; details: string };
  assert.match(body.error, /не удалил образ/);
  assert.match(body.details, /не отработал/);
});

test("чужой контейнер на версии останавливает удаление", async () => {
  const containers = [
    containerLine("333333333333", "webnestdev-server-1", "exited", REPO + ":sha-dddddddddddd"),
  ].join("\n");
  const { app, stub } = await makeApp({ images: IMAGES, containers });
  const response = await del(app, IMAGE_OLD, "confirm=1&containers=remove");
  assert.equal(response.statusCode, 409);
  const body = response.json() as { error: string; holders: Array<{ name: string; removable: boolean }> };
  assert.match(body.error, /не платформы/);
  assert.deepEqual(body.holders.map(holder => holder.removable), [false]);
  assert.equal(stub.calls.filter(args => args[0] === "rm").length, 0);
});

test("окно откката считается по репозиторию, а версия без контейнеров и за окном — старая", () => {
  const inventory = buildReleaseInventory({
    images: parseImageLines(IMAGES),
    containers: parseContainerLines(CONTAINERS),
    keep: 3,
    pattern: "webnestdev",
    nowMs: NOW,
  });
  const statuses = Object.fromEntries(inventory.releases.map(release => [release.id, release.status]));
  assert.equal(statuses[IMAGE_ACTIVE], "active");
  assert.equal(statuses[IMAGE_STUCK], "stuck");
  assert.equal(statuses[IMAGE_PREVIOUS], "previous", "третья версия при keep=3");
  assert.equal(statuses[IMAGE_OLD], "old");
  assert.equal(inventory.summary.oldest?.shortId, IMAGE_OLD.replace("sha256:", "").slice(0, 12));

  // Уменьшили окно — та же версия сразу становится «старой и не удалённой»: именно это состояние
  // человек и ищет глазами, когда диск не освобождается.
  const narrow = buildReleaseInventory({
    images: parseImageLines(IMAGES),
    containers: parseContainerLines(CONTAINERS),
    keep: 2,
    pattern: "webnestdev",
    nowMs: NOW,
  });
  const narrowStatuses = Object.fromEntries(narrow.releases.map(release => [release.id, release.status]));
  assert.equal(narrowStatuses[IMAGE_PREVIOUS], "old");
  assert.equal(narrowStatuses[IMAGE_STUCK], "stuck");
});

test("конфигурация: шаблон по умолчанию и окно откката в разумных границах", () => {
  assert.deepEqual(releaseConfig({}), { pattern: "webnestdev", keep: 2 });
  assert.deepEqual(releaseConfig({ PLATFORM_RELEASES_PATTERN: "myapp", PLATFORM_RELEASES_KEEP: "4" }), { pattern: "myapp", keep: 4 });
  assert.equal(releaseConfig({ PLATFORM_RELEASES_KEEP: "0" }).keep, 2);
  assert.equal(releaseConfig({ PLATFORM_RELEASES_KEEP: "999" }).keep, 10);
  assert.equal(refRepository("ghcr.io/x/webnestdev:sha-abc@sha256:def"), "ghcr.io/x/webnestdev");
  assert.equal(refRepository("webnestdev:production"), "webnestdev");
  assert.equal(refRepository("node"), "node");
});

test("время Docker разбирается с именем зоны, иначе все версии были бы «сейчас»", () => {
  assert.equal(parseDockerDate("2026-11-06 21:00:00 +0300 MSK"), Date.parse("2026-11-06T18:00:00Z"));
  assert.equal(parseDockerDate("2026-11-06 21:00:00 +0300"), Date.parse("2026-11-06T18:00:00Z"));
  assert.equal(parseDockerDate("2 weeks ago"), null);
});
