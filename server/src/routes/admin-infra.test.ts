import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Проверяются чистые части маршрута: разбор вывода Docker, границы диска, классификация песочниц
 * и сортировка списка. Маршрут целиком требует Docker, бакет и базу, поэтому его форма проверяется
 * типами, а арифметика и правила — здесь.
 *
 * Переменные окружения выставляются до импорта: auth-store читает тип хранилища и каталог данных
 * при загрузке модуля.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-infra-"));

const {
  buildSandboxRows,
  diskPressure,
  filterSandboxRows,
  mountFor,
  parseDockerContainers,
  parseDockerDf,
  parseDockerSize,
  parseProcMounts,
  summarizeDockerDf,
} = await import("./admin-infra.js");

test("размер Docker переводится в байты, мусор — в null", () => {
  assert.equal(parseDockerSize("0B"), 0);
  assert.equal(parseDockerSize("1536B"), 1536);
  assert.equal(parseDockerSize("1.5GB"), 1_500_000_000);
  assert.equal(parseDockerSize("12.5MB"), 12_500_000);
  assert.equal(parseDockerSize("4.29GB (50%)"), 4_290_000_000);
  assert.equal(parseDockerSize("1KiB"), 1024);
  assert.equal(parseDockerSize("—"), null);
  assert.equal(parseDockerSize("N/A"), null);
});

test("порог диска: 80% — предупреждение, 90% — опасность", () => {
  assert.equal(diskPressure(0.79), "ok");
  assert.equal(diskPressure(0.8), "warn");
  assert.equal(diskPressure(0.89), "warn");
  assert.equal(diskPressure(0.9), "danger");
  assert.equal(diskPressure(0.99), "danger");
});

test("docker system df читается и из JSON, и из старой таблицы", () => {
  const jsonRows = parseDockerDf([
    JSON.stringify({ Type: "Images", TotalCount: "12", Active: "2", Size: "8.59GB", Reclaimable: "4.29GB (50%)" }),
    JSON.stringify({ Type: "Containers", TotalCount: "37", Active: "3", Size: "1.2MB", Reclaimable: "1.2MB (100%)" }),
    JSON.stringify({ Type: "Build Cache", TotalCount: "4", Active: "0", Size: "0B", Reclaimable: "0B" }),
  ].join("\n"));
  assert.equal(jsonRows.length, 3);
  assert.equal(jsonRows[0].type, "Images");
  assert.equal(jsonRows[0].count, 12);
  assert.equal(jsonRows[0].size, 8_590_000_000);
  assert.equal(jsonRows[0].reclaimable, 4_290_000_000);

  const summary = summarizeDockerDf(jsonRows);
  assert.equal(summary.dockerBytes, 8_590_000_000 + 1_200_000 + 0);
  assert.equal(summary.reclaimableBytes, 4_290_000_000 + 1_200_000 + 0);
  assert.equal(summary.imagesBytes, 8_590_000_000);
  assert.equal(summary.imagesCount, 12);

  const plainRows = parseDockerDf(
    [
      "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE",
      "Images          12        2         8.59GB    4.29GB (50%)",
      "Containers      37        3         1.2MB     1.2MB (100%)",
    ].join("\n"),
  );
  assert.equal(plainRows.length, 2);
  assert.equal(plainRows[0].type, "Images");
  assert.equal(plainRows[0].size, 8_590_000_000);

  // Одна неизвестная строка делает сумму неполной, а не нулевой.
  const incomplete = summarizeDockerDf([
    { type: "Images", count: 1, size: 10, reclaimable: null },
    { type: "Volumes", count: 1, size: null, reclaimable: null },
  ]);
  assert.equal(incomplete.dockerBytes, null);
  assert.equal(incomplete.reclaimableBytes, null);
});

test("контейнеры предпросмотра узнаются по метке, работающий важнее остановленного", () => {
  const output = [
    JSON.stringify({ ID: "old", State: "exited", Names: "wnd-old", Labels: "webnestdev.preview=p1,role=preview" }),
    JSON.stringify({ ID: "new", State: "running", Names: "wnd-new", Labels: "role=preview,webnestdev.preview=p1" }),
    JSON.stringify({ ID: "other", State: "running", Names: "postgres", Labels: "role=db" }),
    JSON.stringify({ ID: "p2", State: "exited", Names: "wnd-p2", Labels: "webnestdev.preview=p2" }),
  ].join("\n");
  const containers = parseDockerContainers(output);
  assert.equal(containers.size, 2);
  assert.deepEqual(containers.get("p1"), { name: "wnd-new", state: "running" });
  assert.deepEqual(containers.get("p2"), { name: "wnd-p2", state: "stopped" });
  assert.equal(containers.has("postgres"), false);
});

test("точка монтирования выбирается самая длинная, пробелы в /proc/mounts раскодируются", () => {
  const mounts = parseProcMounts(
    [
      "/dev/vda1 / ext4 rw 0 0",
      "/dev/vdb1 /var/lib/docker ext4 rw 0 0",
      "/dev/vdc1 /mnt/my\\040disk xfs rw 0 0",
    ].join("\n"),
  );
  assert.equal(mounts[2].mount, "/mnt/my disk");
  assert.deepEqual(mountFor("/var/lib/docker/overlay2", mounts), { device: "/dev/vdb1", mount: "/var/lib/docker" });
  assert.deepEqual(mountFor("/root/project", mounts), { device: "/dev/vda1", mount: "/" });
  assert.deepEqual(mountFor("/mnt/my disk/a", mounts), { device: "/dev/vdc1", mount: "/mnt/my disk" });
});

test("песочницы делятся на running / cold / never и сортируются по последней активности", () => {
  const source = {
    projects: [
      { id: "p1", name: "Магазин", userId: "u1", updatedAt: "2026-10-17T00:00:00.000Z" },
      { id: "p2", name: "Блог", userId: "u2", updatedAt: "2026-10-16T00:00:00.000Z" },
      { id: "p3", name: "Лендинг", userId: "u1", updatedAt: "2026-10-15T00:00:00.000Z" },
      { id: "p4", name: "Новый", userId: "u3", updatedAt: "2026-10-14T00:00:00.000Z" },
      { id: "p5", name: "Без замера", userId: "u1", updatedAt: "2026-10-13T00:00:00.000Z" },
    ],
    sizes: new Map([
      ["p1", { sizeBytes: 100, updatedAt: "2026-10-26T00:00:00.000Z", lastWriteAt: "2026-10-26T00:00:00.000Z" }],
      ["p2", { sizeBytes: 200, updatedAt: "2026-10-20T00:00:00.000Z", lastWriteAt: "2026-10-20T00:00:00.000Z" }],
      ["p3", { sizeBytes: 300, updatedAt: "2026-10-18T00:00:00.000Z", lastWriteAt: "2026-10-18T00:00:00.000Z" }],
    ]),
    archives: new Map([
      ["p2", { projectId: "p2", userId: "u2", key: "k", bytes: 200, archivedAt: "2026-10-20T00:00:00.000Z" }],
    ]),
    emails: new Map([["u1", "one@example.test"], ["u2", "two@example.test"]]),
    directories: new Set(["p3", "p5"]),
    containers: new Map([["p1", { name: "wnd-p1", state: "running" as const }]]),
    previews: new Map([["p1", { mode: "container" as const, startedAt: Date.parse("2026-10-26T09:00:00.000Z"), lastUsedAt: Date.parse("2026-10-26T10:00:00.000Z") }]]),
    access: new Map<string, number>(),
    now: Date.parse("2026-10-26T12:00:00.000Z"),
  };

  const rows = buildSandboxRows(source);
  assert.deepEqual(rows.map(row => [row.projectId, row.state]), [
    ["p1", "running"],
    ["p2", "cold"],
    ["p3", "cold"],
    ["p4", "never"],
    ["p5", "cold"],
  ]);
  assert.equal(rows[0].container, "wnd-p1");
  assert.equal(rows[0].startedAt, "2026-10-26T09:00:00.000Z");
  assert.equal(rows[0].startMs, null, "журнала старта нет — время не выдумывается");
  assert.equal(rows[0].diskBytes, 100);
  assert.equal(rows[1].email, "two@example.test");
  assert.equal(rows[1].container, "");
  assert.equal(rows[2].email, "one@example.test");
  assert.equal(rows[2].diskBytes, 300);
  assert.equal(rows[3].diskBytes, 0, "у проекта без файлов ноль честный");
  assert.equal(rows[3].email, "");
  assert.equal(rows[4].diskBytes, null, "у проекта с файлами, но без замера, размер неизвестен");

  assert.deepEqual(filterSandboxRows(rows, "cold").map(row => row.projectId), ["p2", "p3", "p5"]);
  assert.deepEqual(filterSandboxRows(rows, "never").map(row => row.projectId), ["p4"]);
  assert.equal(filterSandboxRows(rows, "all").length, 5);
  assert.deepEqual(filterSandboxRows(rows, "cold").slice(0, 1).map(row => row.projectId), ["p2"]);
});

test("маршруты закрыты админ-токеном и проверяют limit", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerAdminInfraRoutes } = await import("./admin-infra.js");
  const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

  const app = Fastify();
  await registerAdminInfraRoutes(app);
  const admin = await createAdmin("infra@example.test", "correct-horse-battery");
  const session = await createAdminSession(admin.id);

  const anonymous = await app.inject({ method: "GET", url: "/api/admin/infra" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");

  const badLimit = await app.inject({
    method: "GET",
    url: "/api/admin/sandboxes?state=cold&limit=0",
    headers: { authorization: "Bearer " + session.token },
  });
  assert.equal(badLimit.statusCode, 400);

  const badState = await app.inject({
    method: "GET",
    url: "/api/admin/sandboxes?state=warm",
    headers: { authorization: "Bearer " + session.token },
  });
  assert.equal(badState.statusCode, 400);

  await app.close();
});
