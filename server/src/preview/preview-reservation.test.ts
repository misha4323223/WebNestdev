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

afterEach(() => setPreviewReservationBackendForTests(null));

const live = (projectId: string, userId: string, lastUsedAt: number) => ({ projectId, userId, lastUsedAt });

test("второй запуск того же аккаунта не обгоняет уже идущий старт", () => {
  const decision = decidePreviewReservation({
    projectId: "project-b",
    userId: "user-1",
    perUser: 1,
    hostLimit: 8,
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
    hostLimit: 8,
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
    hostLimit: 2,
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
    hostLimit: 1,
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
    hostLimit: 1,
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
    hostLimit: 8,
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
    hostLimit: 8,
    live: [live("project-a", "user-1", 10)],
    reservations: [],
  });
  assert.deepEqual(decision, { ok: true, stopProjectIds: [] });
});

test("бронь снимается тем же токеном и переживает повторный release", async () => {
  const released: string[] = [];
  const backend: PreviewReservationBackend = {
    enabled: () => true,
    reserve: async () => ({ kind: "acquired", reservationId: "reservation-1", stopProjectIds: [] }),
    release: async input => { released.push(input.reservationId); },
  };
  setPreviewReservationBackendForTests(backend);
  const result = await reservePreviewStart({ projectId: "project-a", userId: "user-1", perUser: 1, hostLimit: 8 });
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
    await reservePreviewStart({ projectId: "project-a", userId: "user-1", perUser: 1, hostLimit: 8 }),
    { kind: "busy", reason: "уже запускается" },
  );
});
