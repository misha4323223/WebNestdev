import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearPreviewReservation,
  decidePreviewReservation,
  findPreviewReservation,
  reservePreviewStart,
  setPreviewReservationBackendForTests,
  type PreviewReservationBackend,
} from "./preview-reservation.js";
import type { RuntimeLimits } from "./preview-capacity.js";

afterEach(() => setPreviewReservationBackendForTests(null));

const live = (projectId: string, userId: string, lastUsedAt: number, node?: string, mode: "container" | "hybrid" = "container") => ({
  projectId,
  userId,
  lastUsedAt,
  node,
  mode,
});

/** Старое правило «N контейнеров на хост» без веса Docker: удобно для прежних проверок. */
const legacy = (limit: number): RuntimeLimits => ({
  containerLimit: limit,
  hybridLimit: limit,
  hostUnits: limit,
  containerUnits: 1,
});

const production: RuntimeLimits = {
  containerLimit: 2,
  hybridLimit: 8,
  hostUnits: 12,
  containerUnits: 6,
};

test("второй запуск того же аккаунта не обгоняет уже идущий старт", () => {
  const decision = decidePreviewReservation({
    projectId: "project-b",
    userId: "user-1",
    perUser: 1,
    limits: legacy(8),
    live: [],
    reservations: [{ projectId: "project-a", userId: "user-1" }],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.match(decision.reason, /уже запускается/);
});

test("смена preview останавливает самый старый свой проект", () => {
  const decision = decidePreviewReservation({
    projectId: "project-c",
    userId: "user-1",
    perUser: 1,
    limits: legacy(8),
    live: [live("project-a", "user-1", 10), live("project-b", "user-1", 20)],
    reservations: [],
  });
  // Чтобы после старта осталось ровно один preview, останавливаются оба старых: одного
  // недостаточно, иначе аккаунт снова оказался бы выше лимита.
  assert.deepEqual(decision, { ok: true, stopProjectIds: ["project-a", "project-b"] });
});

test("чужой preview не останавливается, но занимает место на хосте", () => {
  const decision = decidePreviewReservation({
    projectId: "project-c",
    userId: "user-2",
    perUser: 1,
    limits: legacy(2),
    live: [live("project-a", "user-1", 10), live("project-b", "user-1", 20)],
    reservations: [],
  });
  assert.equal(decision.ok, false);
});

test("останавливаемый preview не мешает новому занять его слот", () => {
  const decision = decidePreviewReservation({
    projectId: "project-c",
    userId: "user-1",
    perUser: 1,
    limits: legacy(1),
    live: [live("project-a", "user-1", 10)],
    reservations: [],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: ["project-a"] });
});

test("бронь другого проекта считается местом на хосте", () => {
  const decision = decidePreviewReservation({
    projectId: "project-c",
    userId: "user-2",
    perUser: 1,
    limits: legacy(1),
    live: [],
    reservations: [{ projectId: "project-a", userId: "user-1" }],
  });
  assert.equal(decision.ok, false);
});

test("без лимита на аккаунт параллельный старт своего же проекта не блокируется", () => {
  const decision = decidePreviewReservation({
    projectId: "project-b",
    userId: "user-1",
    perUser: 0,
    limits: legacy(8),
    live: [],
    reservations: [{ projectId: "project-a", userId: "user-1" }],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: [] });
});

test("без лимита на аккаунт запускаются оба своих проекта", () => {
  const decision = decidePreviewReservation({
    projectId: "project-c",
    userId: "user-1",
    perUser: 0,
    limits: legacy(8),
    live: [live("project-a", "user-1", 10)],
    reservations: [],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: [] });
});

test("потолок хоста не считает preview и брони другой реплики", () => {
  const decision = decidePreviewReservation({
    projectId: "project-new",
    userId: "user-3",
    node: "node-1",
    perUser: 1,
    limits: legacy(2),
    live: [live("project-a", "user-1", 10, "node-2"), live("project-b", "user-2", 20, "node-2")],
    reservations: [{ projectId: "project-c", userId: "user-2", node: "node-2" }],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: [] });
});

test("потолок хоста блокирует только свой узел", () => {
  const decision = decidePreviewReservation({
    projectId: "project-new",
    userId: "user-3",
    node: "node-1",
    perUser: 1,
    limits: legacy(2),
    live: [live("project-a", "user-1", 10, "node-1"), live("project-b", "user-2", 20, "node-2")],
    reservations: [{ projectId: "project-c", userId: "user-2", node: "node-1" }],
  });
  assert.equal(decision.ok, false);
});

test("лимит аккаунта остаётся общим для кластера", () => {
  const decision = decidePreviewReservation({
    projectId: "project-b",
    userId: "user-1",
    node: "node-1",
    perUser: 1,
    limits: legacy(8),
    live: [live("project-a", "user-1", 10, "node-2")],
    reservations: [],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: ["project-a"] });
});

test("бронь снимается тем же токеном и переживает повторный release", async () => {
  const released: string[] = [];
  const backend: PreviewReservationBackend = {
    enabled: () => true,
    reserve: async () => ({ kind: "acquired", reservationId: "reservation-1", stopProjectIds: [] }),
    release: async input => { released.push(input.reservationId); },
  };
  setPreviewReservationBackendForTests(backend);
  const result = await reservePreviewStart({ projectId: "project-a", userId: "user-1", perUser: 1, mode: "container", limits: legacy(8) });
  assert.equal(result.kind, "acquired");
  if (result.kind !== "acquired") return;
  await result.reservation.release();
  await result.reservation.release();
  assert.deepEqual(released, ["reservation-1"], "повторный release не должен трогать backend");
});

test("потерянная бронь снимается по проекту", async () => {
  const cleared: string[] = [];
  const backend: PreviewReservationBackend = {
    enabled: () => true,
    reserve: async () => ({ kind: "acquired", reservationId: "reservation-1", stopProjectIds: [] }),
    release: async () => undefined,
    clear: async projectId => { cleared.push(projectId); },
  };
  setPreviewReservationBackendForTests(backend);
  await clearPreviewReservation("project-a");
  assert.deepEqual(cleared, ["project-a"]);
});

test("админка читает активную бронь проекта", async () => {
  const backend: PreviewReservationBackend = {
    enabled: () => true,
    reserve: async () => ({ kind: "busy", reason: "не используется" }),
    release: async () => undefined,
    get: async projectId => ({
      projectId,
      ownerUserId: "user-1",
      node: "node-1",
      createdAt: 1000,
      expiresAt: 2000,
    }),
  };
  setPreviewReservationBackendForTests(backend);
  assert.deepEqual(await findPreviewReservation("project-a"), {
    projectId: "project-a",
    ownerUserId: "user-1",
    node: "node-1",
    createdAt: 1000,
    expiresAt: 2000,
  });
});

test("снятие брони сообщает, что база его не приняла", async () => {
  const backend: PreviewReservationBackend = {
    enabled: () => true,
    reserve: async () => ({ kind: "busy", reason: "" }),
    release: async () => undefined,
    clear: async () => { throw new Error("нет связи"); },
  };
  setPreviewReservationBackendForTests(backend);
  assert.equal(await clearPreviewReservation("project-a"), false);
});

test("занятая бронь возвращает причину, а не молчаливый отказ", async () => {
  const backend: PreviewReservationBackend = {
    enabled: () => true,
    reserve: async () => ({ kind: "busy", reason: "уже запускается" }),
    release: async () => undefined,
  };
  setPreviewReservationBackendForTests(backend);
  assert.deepEqual(
    await reservePreviewStart({ projectId: "project-a", userId: "user-1", perUser: 1, mode: "container", limits: legacy(8) }),
    { kind: "busy", reason: "уже запускается" },
  );
});

test("2 Docker занимают все 12 слотов и не пускают hybrid", () => {
  const decision = decidePreviewReservation({
    projectId: "project-hybrid",
    userId: "user-3",
    perUser: 1,
    mode: "hybrid",
    limits: production,
    live: [live("docker-a", "user-1", 10), live("docker-b", "user-2", 20)],
    reservations: [],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.match(decision.reason, /12 из 12 слотов/);
});

test("1 Docker оставляет 6 hybrid-слотов", () => {
  const decision = decidePreviewReservation({
    projectId: "project-hybrid",
    userId: "user-8",
    perUser: 1,
    mode: "hybrid",
    limits: production,
    live: [
      live("docker-a", "user-1", 10),
      ...Array.from({ length: 5 }, (_, index) =>
        live("hybrid-" + index, "user-" + (index + 2), 20 + index, undefined, "hybrid"),
      ),
    ],
    reservations: [],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: [] });
});

test("живой preview и его бронь считаются одним слотом, а не двумя", () => {
  const decision = decidePreviewReservation({
    projectId: "project-c",
    userId: "user-3",
    perUser: 1,
    limits: legacy(3),
    live: [live("project-a", "user-1", 10), live("project-b", "user-2", 20)],
    reservations: [{ projectId: "project-a", userId: "user-1" }],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: [] });
});

test("hybrid-бронь занимает hybrid-слот, а не слот Docker", () => {
  const decision = decidePreviewReservation({
    projectId: "project-hybrid",
    userId: "user-2",
    perUser: 1,
    mode: "hybrid",
    limits: production,
    live: [],
    reservations: [{ projectId: "project-a", userId: "user-1", mode: "hybrid" }],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: [] });
});

test("свой Docker освобождает 6 слотов перед запуском hybrid", () => {
  const decision = decidePreviewReservation({
    projectId: "project-hybrid",
    userId: "user-1",
    perUser: 1,
    mode: "hybrid",
    limits: production,
    live: [
      live("docker-a", "user-1", 10),
      ...Array.from({ length: 6 }, (_, index) =>
        live("hybrid-" + index, "user-" + (index + 2), 20 + index, undefined, "hybrid"),
      ),
    ],
    reservations: [],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: ["docker-a"] });
});
