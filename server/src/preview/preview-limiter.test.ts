import test from "node:test";
import assert from "node:assert/strict";
import {
  decideRuntimePreviewStart,
  describePreviewLimits,
  perUserPreviewLimit,
  runtimePreviewLimit,
} from "./preview-limiter.js";

const live = (projectId: string, userId: string, lastUsedAt: number) => ({ projectId, userId, lastUsedAt });

/** Сохранить окружение вокруг теста: переменные лимитов читаются функциями, а не аргументами. */
function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("один аккаунт держит один контейнерный предпросмотр: второй останавливает свой же первый", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("old", "user-1", 100), live("other", "user-2", 900)],
    projectId: "new",
    userId: "user-1",
  });
  assert.deepEqual(decision, { ok: true, stopProjectId: "old" });
});

test("предпросмотр другого пользователя не мешает и не останавливается", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-2", 200)],
    projectId: "c",
    userId: "user-3",
    limit: 0,
  });
  assert.deepEqual(decision, { ok: true });
});

test("перезапуск своего же проекта не считается новым предпросмотром", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("a", "user-1", 100)],
    projectId: "a",
    userId: "user-1",
  });
  assert.deepEqual(decision, { ok: true });
});

test("лимит на аккаунт больше одного: третий предпросмотр останавливает самый старый", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("first", "user-1", 100), live("second", "user-1", 500)],
    projectId: "third",
    userId: "user-1",
    perUser: 2,
  });
  assert.deepEqual(decision, { ok: true, stopProjectId: "first" });
});

test("лимит на аккаунт 0 снимает ограничение", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-1", 200)],
    projectId: "c",
    userId: "user-1",
    perUser: 0,
    limit: 0,
  });
  assert.deepEqual(decision, { ok: true });
});

test("явный 0 снимает предохранитель хоста: чужие предпросмотры не дают отказа", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 1), live("b", "user-2", 2), live("c", "user-3", 3), live("d", "user-4", 4)],
    projectId: "new",
    userId: "user-5",
    limit: 0,
  });
  assert.deepEqual(decision, { ok: true });
});

test("заданный предохранитель хоста отвечает причиной, а не остановкой чужого приложения", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-2", 200)],
    projectId: "d",
    userId: "user-4",
    limit: 2,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.reason, /PREVIEW_MAX_CONTAINERS/);
  assert.match(decision.reason, /2 серверных предпросмотров/);
});

test("предпросмотр без владельца никогда не останавливается за чужой счёт", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("orphan", "", 100), live("b", "user-2", 200)],
    projectId: "d",
    userId: "",
    limit: 0,
  });
  assert.deepEqual(decision, { ok: true }, "пустой userId ничего не присваивает");
});

test("окружение: по умолчанию один предпросмотр на аккаунт и потолок хоста по памяти", () => {
  withEnv({ PREVIEW_MAX_PER_USER: undefined, PREVIEW_MAX_CONTAINERS: undefined }, () => {
    assert.equal(perUserPreviewLimit(), 1);
    assert.ok(runtimePreviewLimit() >= 1, "потолок хоста обязан быть конечным");
    assert.match(describePreviewLimits(), /одновременно на хосте: \d+/);
  });
});

test("окружение: PREVIEW_MAX_PER_USER и PREVIEW_MAX_CONTAINERS читаются и понимают 0", () => {
  withEnv({ PREVIEW_MAX_PER_USER: "2", PREVIEW_MAX_CONTAINERS: "4" }, () => {
    assert.equal(perUserPreviewLimit(), 2);
    assert.equal(runtimePreviewLimit(), 4);
    assert.equal(describePreviewLimits(), "предпросмотров на аккаунт: 2; одновременно на хосте: 4");
  });
  withEnv({ PREVIEW_MAX_PER_USER: "0", PREVIEW_MAX_CONTAINERS: "0" }, () => {
    assert.equal(perUserPreviewLimit(), 0);
    assert.equal(runtimePreviewLimit(), 0);
    assert.equal(describePreviewLimits(), "предпросмотров на аккаунт: без ограничения; одновременно на хосте: без ограничения");
  });
  withEnv({ PREVIEW_MAX_PER_USER: "мусор", PREVIEW_MAX_CONTAINERS: "-1" }, () => {
    assert.equal(perUserPreviewLimit(), 1, "нечитаемое значение возвращает правило по умолчанию");
    assert.ok(runtimePreviewLimit() >= 1, "нечитаемое значение возвращает потолок по памяти, а не снимает его");
  });
});
